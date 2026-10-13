#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import fs from "fs"

// Dry run: builds the meta package and runs `npm publish --dry-run` for every package (no upload,
// no registry writes, no docker). Real publish needs HORDECODE_RELEASE_CONFIRMED=1.
const dryRun = process.env.HORDECODE_PUBLISH_DRY_RUN === "1"
if (!dryRun && process.env.HORDECODE_RELEASE_CONFIRMED !== "1") {
  console.error(
    "Blocked: set HORDECODE_RELEASE_CONFIRMED=1 to publish, or HORDECODE_PUBLISH_DRY_RUN=1 to rehearse (local-only policy).",
  )
  process.exit(1)
}

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  if (dryRun) {
    await $`npm publish *.tgz --access public --tag ${Script.channel} --dry-run`.cwd(dir)
    return
  }
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

// Preflight (fork-only, ticket incident): upstream publish.ts:26-31 globs whatever sits in
// dist/ and publishes it. A partial dist (a --single rebuild after the full build wiped it) then ships
// a meta package whose optionalDependencies point at packages that were never uploaded. Refuse to
// start unless dist/ holds exactly the 12 platform packages of build.ts:142-203, every one at the
// version this release is for, each with its binary in place.
const allPlatforms = [
  "linux-arm64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64-musl",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
].map((suffix) => `${pkg.name}-${suffix}`)
// Rehearsal on a single native runner (fork-platform-smoke.yml): a dry run may name the
// targets it built; the real publish always requires all twelve.
const rehearsalTargets = dryRun ? (process.env.HORDECODE_PUBLISH_DRY_RUN_TARGETS ?? "") : ""
const expectedPlatforms = rehearsalTargets
  ? rehearsalTargets.split(",").map((suffix) => `${pkg.name}-${suffix.trim()}`)
  : allPlatforms

const version = Script.version
const problems: string[] = []
if (version !== pkg.version)
  problems.push(
    `release version ${version} != package.json version ${pkg.version} (set OPENCODE_VERSION=${pkg.version})`,
  )
const present = new Set<string>()
if (!fs.existsSync("./dist")) problems.push("missing dist/ (run script/build.ts first)")
else
  // Bun.Glob returns backslash-separated paths on Windows (upstream publish.ts:27-29 reads the name
  // from the file instead), so split on either separator.
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" }))
    present.add(filepath.split(/[\\/]/)[0])
for (const name of expectedPlatforms) {
  if (!present.has(name)) {
    problems.push(`missing dist/${name}`)
    continue
  }
  const dist = await Bun.file(`./dist/${name}/package.json`).json()
  if (dist.name !== name) problems.push(`dist/${name}/package.json names ${dist.name}`)
  if (dist.version !== version) problems.push(`dist/${name} is ${dist.version}, release is ${version}`)
  const bin = name.includes("windows") ? `./dist/${name}/bin/hordecode.exe` : `./dist/${name}/bin/hordecode`
  if (!(await Bun.file(bin).exists())) problems.push(`missing binary ${bin}`)
}
for (const name of present) {
  // dist/<pkg.name>/ is the meta package generated below (a rehearsal or earlier run leaves it
  // behind); anything else that is not a platform package is a stale or foreign directory.
  if (name !== pkg.name && !allPlatforms.includes(name)) problems.push(`unexpected dist/${name}`)
}
if (problems.length) {
  console.error(`Preflight refused (${problems.length} problem(s)); nothing was packed or published:`)
  for (const item of problems) console.error(`  - ${item}`)
  process.exit(1)
}
const binaries: Record<string, string> = Object.fromEntries(expectedPlatforms.map((name) => [name, version]))
console.log(`preflight ok: ${expectedPlatforms.length}/${expectedPlatforms.length} platform packages at ${version}`)
console.log("binaries", binaries)

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
// npm renders the package page from the tarball's README.md (MiMo publish.ts:38 ships one; upstream
// publish.ts:37 ships only LICENSE). Relative repo links do not resolve on npmjs.com, so point them at GitHub.
const repoRaw = "https://raw.githubusercontent.com/siliconstencil/hordecode/main/"
const repoBlob = "https://github.com/siliconstencil/hordecode/blob/main/"
const readme = (await Bun.file("../../README.md").text())
  .replaceAll('src="assets/', `src="${repoRaw}assets/`)
  .replaceAll('href="LICENSE"', `href="${repoBlob}LICENSE"`)
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_m, rel: string) => `](${repoBlob}${rel})`)
await Bun.file(`./dist/${pkg.name}/README.md`).write(readme)
// Placeholder shims for both commands; postinstall.mjs replaces them with the platform binary.
const bins = Object.keys(pkg.bin) as string[]
for (const bin of bins) {
  await Bun.file(`./dist/${pkg.name}/bin/${bin}.exe`).write(
    [
      `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
      'echo "" >&2',
      'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
      'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
      'echo "" >&2',
      'echo "To fix this, run the postinstall script manually:" >&2',
      `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
      'echo "" >&2',
      `echo "Or reinstall ${pkg.name} without the --ignore-scripts flag." >&2`,
      "exit 1",
      "",
    ].join("\n"),
  )
}

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      description:
        "Hordecode: AI coding agent for the terminal, a friendly fork of opencode with a MiMo Code delta-port",
      bin: Object.fromEntries(bins.map((bin) => [bin, `./bin/${bin}.exe`])),
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      homepage: "https://hordecode.com",
      repository: { type: "git", url: "git+https://github.com/siliconstencil/hordecode.git" },
      bugs: { url: "https://github.com/siliconstencil/hordecode/issues" },
      keywords: ["ai", "agent", "cli", "coding-assistant", "opencode", "hordecode"],
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  await publish(`./dist/${name}`, name, binaries[name])
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, pkg.name, version)

const image = "ghcr.io/siliconstencil/hordecode"
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// Secondary distribution (ghcr.io image, AUR packages, Homebrew tap) runs only when a maintainer
// asks for it: every step below needs the GitHub release assets (sha256 of the zips), GHCR write
// access, an AUR ssh key and the homebrew-tap repo. npm publishing above never depends on it.
if (!Script.preview && !dryRun && process.env.HORDECODE_DISTRIBUTION === "1") {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/hordecode-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/hordecode-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/hordecode-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/hordecode-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    "pkgname='opencode-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/siliconstencil/hordecode'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('opencode')",
    "conflicts=('opencode')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/siliconstencil/hordecode/releases/download/v\${pkgver}\${_subver}/hordecode-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/siliconstencil/hordecode/releases/download/v\${pkgver}\${_subver}/hordecode-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./hordecode "${pkgdir}/usr/bin/hordecode"',
    "}",
    "",
  ].join("\n")

  for (const [pkg, pkgbuild] of [["opencode-bin", binaryPkgbuild]]) {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-${pkg}`
        await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
        await $`cd ./dist/aur-${pkg} && git checkout master`
        await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
        await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
        await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-${pkg} && git push`
        break
      } catch {
        continue
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Opencode < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/siliconstencil/hordecode"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/siliconstencil/hordecode/releases/download/v${Script.version}/hordecode-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "hordecode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/siliconstencil/hordecode/releases/download/v${Script.version}/hordecode-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "hordecode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/siliconstencil/hordecode/releases/download/v${Script.version}/hordecode-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "hordecode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/siliconstencil/hordecode/releases/download/v${Script.version}/hordecode-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "hordecode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("GITHUB_TOKEN is required to update homebrew tap")
    process.exit(1)
  }
  const tap = `https://x-access-token:${token}@github.com/siliconstencil/homebrew-hordecode.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/opencode.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add opencode.rb`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
