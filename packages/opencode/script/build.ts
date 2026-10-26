#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { rehashMachO } from "./macho-rehash"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"

function getDirSize(dirPath: string): string {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dirPath, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        try {
          total += fs.statSync(path.join((entry as unknown as { path: string }).path ?? dirPath, entry.name)).size
        } catch {}
      }
    }
  } catch {}
  return (total / 1024 / 1024).toFixed(1)
}

function copyOnnxDlls(targetDir: string, os: string, arch: string) {
  if (os !== "linux" || arch !== "x64") {
    console.warn(`  WARN ONNX vendoring skipped for ${os}-${arch} (verified only for linux-x64, BM25 fallback)`)
    return
  }
  const vendorDir = path.resolve(targetDir, "vendor")
  fs.mkdirSync(vendorDir, { recursive: true })
  const bunCache = path.resolve(dir, "../../node_modules/.bun")
  function resolveCache(pkgKey: string): string {
    try {
      const entry = fs.readdirSync(bunCache).find((e) => e.startsWith(pkgKey))
      if (!entry) return ""
      const subPath = pkgKey.includes("+") ? pkgKey.split("+").join("/").replace(/@[\d.]+.*$/, "") : pkgKey.replace(/@[\d.]+.*$/, "")
      return path.join(bunCache, entry, "node_modules", subPath)
    } catch {
      return ""
    }
  }
  const onnxNodeDir = resolveCache("onnxruntime-node@1.24.3")
  const nativeDir = path.join(onnxNodeDir, `bin/napi-v6/${os}/${arch}`)
  const rtDir = path.resolve(targetDir, "runtime", "onnxruntime")
  fs.mkdirSync(rtDir, { recursive: true })
  if (onnxNodeDir && fs.existsSync(path.join(nativeDir, "onnxruntime_binding.node"))) {
    for (const f of fs.readdirSync(nativeDir)) {
      const fp = path.join(nativeDir, f)
      try {
        fs.cpSync(fp, path.join(rtDir, f))
        if (f.endsWith(".so") || f === "onnxruntime.dll") fs.cpSync(fp, path.join(targetDir, f))
      } catch {}
    }
    console.log(`  -> runtime/onnxruntime/: native files (${getDirSize(rtDir)} MB)`)
  } else {
    console.warn(`  WARN onnxruntime native binaries not found at ${nativeDir}, BM25 fallback`)
  }
  const nmDir = path.join(vendorDir, "node_modules")
  const hfDir = (() => {
    const local = path.resolve(dir, "../memory/node_modules/@huggingface/transformers")
    if (fs.existsSync(path.join(local, "package.json"))) return local
    const cached = resolveCache("@huggingface+transformers@4.2.0")
    if (cached) return cached
    return path.resolve(dir, "../../node_modules/@huggingface/transformers")
  })()
  if (fs.existsSync(path.join(hfDir, "dist/transformers.node.cjs"))) {
    fs.mkdirSync(path.join(nmDir, "@huggingface", "transformers", "dist"), { recursive: true })
    fs.cpSync(path.join(hfDir, "dist/transformers.node.cjs"), path.join(nmDir, "@huggingface/transformers/dist/transformers.node.cjs"))
    fs.cpSync(path.join(hfDir, "package.json"), path.join(nmDir, "@huggingface/transformers/package.json"))
  }
  if (onnxNodeDir && fs.existsSync(onnxNodeDir)) {
    const onnxNmDir = path.join(nmDir, "onnxruntime-node")
    fs.mkdirSync(path.join(onnxNmDir, "dist"), { recursive: true })
    const distDir = path.join(onnxNodeDir, "dist")
    if (fs.existsSync(distDir)) {
      for (const f of fs.readdirSync(distDir)) if (f.endsWith(".js")) fs.cpSync(path.join(distDir, f), path.join(onnxNmDir, "dist", f))
    }
    const vendorNative = path.join(onnxNmDir, `bin/napi-v6/${os}/${arch}`)
    fs.mkdirSync(vendorNative, { recursive: true })
    // The binding (.node) is required by onnxruntime-node/dist/binding.js from this vendor path.
    // libonnxruntime.so.1 is loaded once from runtime/onnxruntime/ (DT_NEEDED of the binding
    // dlopen'd by memory/src/embedding/service.ts) and the dynamic linker resolves the soname to
    // that copy; a second copy here was never opened (strace, 2026-10-20) and cost 35 MB per package.
    if (fs.existsSync(nativeDir))
      for (const f of fs.readdirSync(nativeDir)) {
        if (f.startsWith("libonnxruntime")) continue
        fs.cpSync(path.join(nativeDir, f), path.join(vendorNative, f))
      }
    fs.cpSync(path.join(onnxNodeDir, "package.json"), path.join(onnxNmDir, "package.json"))
  }
  const commonDir = resolveCache("onnxruntime-common@1.24.3")
  if (commonDir && fs.existsSync(commonDir)) {
    const commonNmDir = path.join(nmDir, "onnxruntime-common")
    const cDist = path.join(commonDir, "dist")
    if (fs.existsSync(cDist)) fs.cpSync(cDist, path.join(commonNmDir, "dist"), { recursive: true })
    fs.cpSync(path.join(commonDir, "package.json"), path.join(commonNmDir, "package.json"))
  }
  // sharp is optional image dep for transformers (required at top-level but only for image pipelines)
  // Provide a stub so text embeddings work without vendoring native sharp
  const sharpDir = path.join(nmDir, "sharp")
  fs.mkdirSync(sharpDir, { recursive: true })
  fs.writeFileSync(path.join(sharpDir, "package.json"), JSON.stringify({ name: "sharp", version: "0.0.0-stub", main: "index.js" }))
  fs.writeFileSync(path.join(sharpDir, "index.js"), 'module.exports = function(){ throw new Error("sharp stub"); };\nmodule.exports.default = null;\n')
  fs.writeFileSync(path.join(vendorDir, "package.json"), JSON.stringify({ name: "hordecode-vendor", version: "0.0.0", private: true }))
  console.log(`  -> vendor dir ready (${getDirSize(vendorDir)} MB)`)
}

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targetFilter = (() => {
  const idx = process.argv.indexOf("--target")
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  if (process.argv.includes("--win32-x64")) return "windows-x64"
  return null
})()

const targets = targetFilter
  ? allTargets.filter((item) => {
      const name = [item.os === "win32" ? "windows" : item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi].filter(Boolean).join("-")
      const full = `${pkg.name}-${name}`
      if (full === targetFilter || name === targetFilter) return true
      // short form like "linux-x64" or "win32-x64" / "windows-x64" -> match only base variant (no baseline, no abi)
      const short = `${item.os}-${item.arch}`
      const shortWin = item.os === "win32" ? `windows-${item.arch}` : short
      if ((short === targetFilter || shortWin === targetFilter) && item.avx2 !== false && item.abi === undefined) return true
      return false
    })
  : singleFlag
    ? allTargets.filter((item) => {
        if (item.os !== process.platform || item.arch !== process.arch) {
          return false
        }

        // When building for the current platform, prefer a single native binary by default.
        // Baseline binaries require additional Bun artifacts and can be flaky to download.
        if (item.avx2 === false) {
          return baselineFlag
        }

        // also skip abi-specific builds for the same reason
        if (item.abi !== undefined) {
          return false
        }

        return true
      })
    : allTargets

if (targetFilter) {
  for (const item of targets) {
    const name = [pkg.name, item.os === "win32" ? "windows" : item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi].filter(Boolean).join("-")
    await $`rm -rf dist/${name}`.nothrow()
  }
} else {
  await $`rm -rf dist`
}

const binaries: Record<string, string> = {}
if (!skipInstall) {
  // Bun 1.4.4 skips native packages for the other libc by default, but the musl targets need them.
  await $`bun install --os="*" --cpu="*" --libc="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" --libc="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" --libc="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  // onnxruntime-node ships native bindings only for some targets (1.24.3: linux x64/arm64,
  // darwin arm64, win32 x64/arm64). @huggingface/transformers requires it at module top level and
  // vendor-require.ts has a literal fallback require, so the bundler pulls both in and fails to
  // resolve the missing .node for a target without a binding (darwin-x64). For such targets both
  // packages stay external: at runtime vendorRequire's try/catch degrades memory to BM25-only.
  const onnxNativePresent = (() => {
    const bunCache = path.resolve(dir, "../../node_modules/.bun")
    const entry = fs.existsSync(bunCache) ? fs.readdirSync(bunCache).find((e) => e.startsWith("onnxruntime-node@")) : undefined
    return entry
      ? fs.existsSync(path.join(bunCache, entry, "node_modules/onnxruntime-node/bin/napi-v6", item.os, item.arch, "onnxruntime_binding.node"))
      : false
  })()
  const external = ["node-gyp", ...(onnxNativePresent ? [] : ["@huggingface/transformers", "onnxruntime-node"])]
  if (!onnxNativePresent) console.warn(`  WARN no onnxruntime native binding for ${item.os}/${item.arch}: transformers + onnxruntime-node left external (BM25-only memory at runtime)`)

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external,
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/hordecode`,
      execArgv: [`--user-agent=hordecode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      HORDECODE_VERSION: `'${pkg.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      HORDECODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Bun inlines the source tree's absolute path into the compiled bundle (import.meta.dir,
  // __dirname of bundled modules). Overwrite every occurrence with a fixed placeholder of the
  // same length so the binary carries no build-machine path and the build can run from any
  // directory. Nothing resolves files through that path at run time: the executable's own
  // directory (process.execPath) and the embedded $bunfs root are used instead.
  {
    const file = `dist/${name}/bin/hordecode${item.os === "win32" ? ".exe" : ""}`
    const needle = Buffer.from(path.resolve(dir, "../.."))
    const placeholder = Buffer.from("/hordecode-build".padEnd(needle.length, "/").slice(0, needle.length))
    const buf = fs.readFileSync(file)
    let count = 0
    for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + needle.length)) {
      placeholder.copy(buf, at)
      count++
    }
    if (count > 0) fs.writeFileSync(file, buf)
    console.log(`  -> build path scrubbed: ${count} occurrence(s) of the source tree path replaced`)
  }

  // The scrub above edits bytes that Bun's ad-hoc signature already hashed. Recompute the page hashes so a
  // Linux cross build does not ship a stale signature (codesign below only runs on macOS).
  if (item.os === "darwin") {
    const rehashed = rehashMachO(`dist/${name}/bin/hordecode`)
    if (rehashed) console.log(`  -> code signature page hashes rewritten: ${rehashed.changed} of ${rehashed.pages}`)
  }

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS 27+
  // SIGKILLs binaries with invalid pages. Re-sign ad-hoc; release CI re-signs with Developer ID.
  if (item.os === "darwin" && process.platform === "darwin") {
    await $`codesign --force --sign - dist/${name}/bin/hordecode`
  }

  await Bun.write(
    path.join("dist", name, "models-snapshot.js"),
    `// Auto-generated by build.ts - do not edit\nexport const snapshot = ${generated.modelsData}\n`,
  )

  try {
    copyOnnxDlls(path.resolve(dir, `dist/${name}/bin`), item.os, item.arch)
  } catch (e) {
    console.warn(`  WARN ONNX vendoring failed for ${name}:`, e, "(BM25 fallback)")
  }

  // Add a `bin/horde` symlink next to `bin/hordecode` so the `horde` bin entry
  // resolves from an unpacked POSIX dist. Windows gets no second file: a copy
  // doubled the platform package (about 138 MB tarball),
  // and postinstall.mjs already installs both commands from the one
  // hordecode.exe it finds in the platform package.
  if (item.os !== "win32") {
    const hordecodeBin = path.join("dist", name, "bin", "hordecode")
    const hordeBin = path.join("dist", name, "bin", "horde")
    try {
      fs.symlinkSync("hordecode", hordeBin)
    } catch {
      fs.copyFileSync(hordecodeBin, hordeBin)
    }
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/hordecode`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
