import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { revokeTrust } from "@opencode-ai/project/workspace-trust"
import { LSP } from "../../src/lsp/lsp"
import { TrustGate } from "../../src/project/trust-gate"
import { provideInstance, testTmpRoot } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Install } from "./harness"
import { lazyLayer, markerExists } from "./harness"
import { installResponder, readRecorded } from "./lsp-recorder"
import { holdGlobalConfig } from "./global-config"

// K8: for an untrusted project no server starts when starting it runs project code the
// server loads from the project - build scripts, plugins, rc files, a project interpreter
// or environment. The evidence for each decision is in the table in the K8 report. A
// trusted project keeps its existing start path; these tests use a recording server, so
// no real language server (or its project toolchain) is installed or executed.

const installs: Install[] = []
const it = testEffect(lazyLayer(installs))
const tyIt = testEffect(lazyLayer(installs, { experimentalLspTy: true }))

const bases: string[] = []
const trusted: string[] = []
const restorers: (() => void)[] = []

let stderr: ReturnType<typeof spyOn>
let markerDir = ""
let savedPath: string | undefined
let savedVSCode: string | undefined
let savedBin: string
let releaseGlobalConfig: (() => Promise<void>) | undefined

const clean = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)

beforeAll(async () => {
  releaseGlobalConfig = await holdGlobalConfig({ lsp: {} })
})

afterAll(async () => {
  await releaseGlobalConfig?.()
  releaseGlobalConfig = undefined
})

beforeEach(async () => {
  installs.length = 0
  TrustGate._resetMayRunCache?.()
  markerDir = await fs.mkdtemp(path.join(testTmpRoot(), "k8-lsp-project-code-"))
  process.env.K2_MARKER_DIR = markerDir
  savedPath = process.env.PATH
  savedVSCode = process.env.VSCODE_EXTENSIONS
  savedBin = Global.Path.bin
  // Every fixture resolves its managed binaries here, so the host's shared cache cannot
  // start a neighbour of the server under test.
  Global.Path.bin = path.join(markerDir, "global-bin")
  stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedVSCode === undefined) delete process.env.VSCODE_EXTENSIONS
  else process.env.VSCODE_EXTENSIONS = savedVSCode
  Global.Path.bin = savedBin
  delete process.env.K2_MARKER_DIR
  stderr?.mockRestore()
  for (const restore of restorers.splice(0)) restore()
  for (const dir of trusted.splice(0)) await revokeTrust(dir).catch(() => undefined)
  for (const base of bases.splice(0)) await clean(base)
  TrustGate._resetMayRunCache?.()
})

const inside = <A, E, R>(directory: string, trust: boolean, body: () => Effect.Effect<A, E, R>) =>
  Effect.suspend(body).pipe(provideInstance(directory, { trust }))

async function project(name: string, files: Record<string, string>) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot(), `k8-${name}-`)))
  bases.push(dir)
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(dir, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Bun.write(target, body)
  }
  return dir
}

type Kind = "path" | "java" | "kotlin" | "razor"

type Case = {
  readonly name: string
  readonly id: string
  readonly binary: string
  readonly marker: string
  readonly file: string
  readonly files: Record<string, string>
  readonly kind?: Kind
  readonly ty?: boolean
}

// K8: the server-specific precondition that lets the fixture reach spawn. `path` is the
// usual PATH shim; the others need the launcher a server checks before spawning.
async function prepare(item: Case) {
  const markerPath = path.join(markerDir, item.marker)
  const bin = path.join(markerDir, "bin")
  await fs.mkdir(bin, { recursive: true })
  switch (item.kind) {
    case "java": {
      const recorder = path.join(markerDir, "java-recorder")
      await installResponder(recorder, markerPath)
      const shim = path.join(bin, "java")
      await Bun.write(
        shim,
        [
          "#!/bin/sh",
          'if [ "$1" = "-version" ]; then echo \'openjdk version "21.0.1" 2024-01-01\' >&2; exit 0; fi',
          `exec ${JSON.stringify(recorder)} "$@"`,
          "",
        ].join("\n"),
      )
      await fs.chmod(shim, 0o755)
      const plugins = path.join(Global.Path.bin, "jdtls", "plugins")
      await fs.mkdir(plugins, { recursive: true })
      await Bun.write(path.join(plugins, "org.eclipse.equinox.launcher_1.0.0.jar"), "")
      break
    }
    case "kotlin": {
      // Bun treats a .sh file as a shell script, so the launcher is a shell wrapper
      // around an extensionless Bun recorder.
      const recorder = path.join(markerDir, "kotlin-recorder")
      await installResponder(recorder, markerPath)
      const launcher = path.join(
        Global.Path.bin,
        "kotlin-ls",
        process.platform === "win32" ? "kotlin-lsp.cmd" : "kotlin-lsp.sh",
      )
      await fs.mkdir(path.dirname(launcher), { recursive: true })
      await Bun.write(launcher, ["#!/bin/sh", `exec ${JSON.stringify(recorder)} "$@"`, ""].join("\n"))
      await fs.chmod(launcher, 0o755)
      break
    }
    case "razor": {
      await installResponder(path.join(bin, item.binary), markerPath)
      const root = path.join(markerDir, "vscode")
      const extension = path.join(root, "ms-dotnettools.csharp-1", ".razorExtension")
      await fs.mkdir(path.join(extension, "Targets"), { recursive: true })
      await Bun.write(path.join(extension, "Microsoft.CodeAnalysis.Razor.Compiler.dll"), "")
      await Bun.write(path.join(extension, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets"), "")
      await Bun.write(path.join(extension, "Microsoft.VisualStudioCode.RazorExtension.dll"), "")
      process.env.VSCODE_EXTENSIONS = root
      break
    }
    default:
      await installResponder(path.join(bin, item.binary), markerPath)
  }
  if (item.id === "astro") {
    // Astro's denied branch asks for the managed TypeScript lib, and the security
    // harness replaces the npm installer with a die. Hand it a seeded managed copy so a
    // pre-fix spawn is visible instead of stopping at the missing tsdk.
    const managed = path.join(markerDir, "managed-typescript")
    await fs.mkdir(path.join(managed, "lib"), { recursive: true })
    await Bun.write(path.join(managed, "lib", "tsserver.js"), "// managed tsserver\n")
    const add = spyOn(Npm, "add").mockImplementation(async () => ({ directory: managed, entrypoint: undefined }))
    restorers.push(() => add.mockRestore())
  }
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`
}

const marker = (name: string) => Effect.promise(() => markerExists(markerDir, name))
const markerSoon = (name: string) =>
  Effect.promise(async () => ((await markerExists(markerDir, name)) ? true : undefined))
const recordedInit = (name: string) => Effect.promise(() => readRecorded(markerDir, name))

const warned = (dir: string) =>
  stderr.mock.calls.some((call: unknown[]) => {
    const line = String(call[0])
    return line.includes(dir) && line.includes("outside every trusted root")
  })

const typescript = {
  "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "5.6.3" }),
  "node_modules/typescript/lib/tsserver.js": "// project tsserver\n",
}

const cases: Case[] = [
  {
    name: "RuboCop",
    id: "ruby-lsp",
    binary: "rubocop",
    marker: "k8-ruby-init.json",
    file: "app.rb",
    files: { Gemfile: "source 'https://rubygems.org'\n", "app.rb": "puts 1\n" },
  },
  {
    name: "JDTLS",
    id: "jdtls",
    binary: "java",
    marker: "k8-jdtls-init.json",
    file: "src/Main.java",
    files: { "settings.gradle": "rootProject.name = 'app'\n", "src/Main.java": "class Main {}\n" },
    kind: "java",
  },
  {
    name: "Kotlin",
    id: "kotlin-ls",
    binary: "kotlin-lsp",
    marker: "k8-kotlin-init.json",
    file: "src/Main.kt",
    files: { "settings.gradle.kts": "rootProject.name = \"app\"\n", "src/Main.kt": "fun main() {}\n" },
    kind: "kotlin",
  },
  {
    name: "SourceKit",
    id: "sourcekit-lsp",
    binary: "sourcekit-lsp",
    marker: "k8-sourcekit-init.json",
    file: "Sources/App/main.swift",
    files: { "Package.swift": "// swift-tools-version:5.9\n", "Sources/App/main.swift": "print(1)\n" },
  },
  {
    name: "C#",
    id: "csharp",
    binary: "roslyn-language-server",
    marker: "k8-csharp-init.json",
    file: "Program.cs",
    files: { "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n", "Program.cs": "class Program {}\n" },
  },
  {
    name: "Razor",
    id: "razor",
    binary: "roslyn-language-server",
    marker: "k8-razor-init.json",
    file: "Pages/Index.razor",
    files: { "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n", "Pages/Index.razor": "<h1>Hi</h1>\n" },
    kind: "razor",
  },
  {
    name: "F#",
    id: "fsharp",
    binary: "fsautocomplete",
    marker: "k8-fsharp-init.json",
    file: "Program.fs",
    files: { "App.fsproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />\n", "Program.fs": "printfn \"hi\"\n" },
  },
  {
    name: "rust-analyzer",
    id: "rust",
    binary: "rust-analyzer",
    marker: "k8-rust-init.json",
    file: "src/main.rs",
    files: { "Cargo.toml": "[package]\nname = \"app\"\n", "src/main.rs": "fn main() {}\n" },
  },
  {
    name: "ElixirLS",
    id: "elixir-ls",
    binary: "elixir-ls",
    marker: "k8-elixir-init.json",
    file: "lib/app.ex",
    files: { "mix.exs": "defmodule App.MixProject do\nend\n", "lib/app.ex": "defmodule App do\nend\n" },
  },
  {
    name: "ZLS",
    id: "zls",
    binary: "zls",
    marker: "k8-zls-init.json",
    file: "src/main.zig",
    files: { "build.zig": "const std = @import(\"std\");\n", "src/main.zig": "pub fn main() void {}\n" },
  },
  {
    name: "TexLab",
    id: "texlab",
    binary: "texlab",
    marker: "k8-texlab-init.json",
    file: "main.tex",
    files: { ".latexmkrc": "1;\n", "main.tex": "\\documentclass{article}\n" },
  },
  {
    name: "Lua",
    id: "lua-ls",
    binary: "lua-language-server",
    marker: "k8-lua-init.json",
    file: "main.lua",
    files: { ".luarc.json": "{}\n", "main.lua": "local x = 1\n" },
  },
  {
    name: "Haskell",
    id: "haskell-language-server",
    binary: "haskell-language-server-wrapper",
    marker: "k8-hls-init.json",
    file: "src/Main.hs",
    files: { "stack.yaml": "resolver: lts-22.0\n", "src/Main.hs": "main :: IO ()\nmain = pure ()\n" },
  },
  {
    name: "Pyright",
    id: "pyright",
    binary: "pyright-langserver",
    marker: "k8-pyright-init.json",
    file: "main.py",
    files: { "pyproject.toml": "[project]\nname = \"app\"\n", "main.py": "value = 1\n" },
  },
  {
    name: "Ty",
    id: "ty",
    binary: "ty",
    marker: "k8-ty-init.json",
    file: "main.py",
    files: { "pyproject.toml": "[project]\nname = \"app\"\n", "main.py": "value = 1\n" },
    ty: true,
  },
  {
    name: "Prisma",
    id: "prisma",
    binary: "prisma",
    marker: "k8-prisma-init.json",
    file: "prisma/schema.prisma",
    files: { "prisma/schema.prisma": "datasource db {\n  provider = \"sqlite\"\n}\n" },
  },
  {
    name: "Astro",
    id: "astro",
    binary: "astro-ls",
    marker: "k8-astro-init.json",
    file: "src/pages/index.astro",
    files: { "package.json": "{}\n", "src/pages/index.astro": "---\n---\n<h1>Hi</h1>\n", ...typescript },
  },
  {
    name: "clojure-lsp",
    id: "clojure-lsp",
    binary: "clojure-lsp",
    marker: "k8-clojure-init.json",
    file: "src/app/core.clj",
    files: { "deps.edn": "{}\n", "src/app/core.clj": "(ns app.core)\n" },
  },
  {
    name: "nixd",
    id: "nixd",
    binary: "nixd",
    marker: "k8-nixd-init.json",
    file: "default.nix",
    files: { "flake.nix": "{}\n", "default.nix": "{}\n" },
  },
  {
    name: "Dart",
    id: "dart",
    binary: "dart",
    marker: "k8-dart-init.json",
    file: "lib/main.dart",
    files: { "pubspec.yaml": "name: app\n", "lib/main.dart": "void main() {}\n" },
  },
  {
    name: "terraform-ls",
    id: "terraform",
    binary: "terraform-ls",
    marker: "k8-terraform-init.json",
    file: "main.tf",
    files: { "main.tf": "terraform {}\n" },
  },
  {
    name: "OCaml",
    id: "ocaml-lsp",
    binary: "ocamllsp",
    marker: "k8-ocaml-init.json",
    file: "bin/main.ml",
    files: { "dune-project": "(lang dune 3.0)\n", "bin/main.ml": "let () = ()\n" },
  },
  {
    name: "Julia",
    id: "julials",
    binary: "julia",
    marker: "k8-julia-init.json",
    file: "src/main.jl",
    files: { "Project.toml": "name = \"App\"\n", "src/main.jl": "module App\nend\n" },
  },
]

const untrusted = (item: Case) =>
  (item.ty ? tyIt : it).live(`an untrusted project does not start ${item.id}`, () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => project(`untrusted-${item.id}`, item.files))
      yield* Effect.promise(() => prepare(item))
      yield* inside(dir, false, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, item.file)).pipe(Effect.forkChild)
          // Watch the marker a spawned recorder would write instead of only joining the
          // fiber, so a pre-fix spawn is a visible failure rather than a timeout.
          yield* pollWithTimeout(markerSoon(item.marker), `${item.name} spawned`).pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          )
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(yield* marker(item.marker)).toBe(false)
          const status = yield* lsp.status()
          expect(status.some((entry) => entry.id === item.id)).toBe(false)
        }),
      )
      expect(warned(dir)).toBe(true)
    }),
  )

const trustedCase = (item: Case) =>
  (item.ty ? tyIt : it).live(`a trusted project starts ${item.id}`, () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => project(`trusted-${item.id}`, item.files))
      trusted.push(dir)
      yield* Effect.promise(() => prepare(item))
      yield* inside(dir, true, () =>
        Effect.gen(function* () {
          const lsp = yield* LSP.Service
          const fiber = yield* lsp.touchFile(path.join(dir, item.file)).pipe(Effect.forkChild)
          const init = yield* pollWithTimeout(
            recordedInit(item.marker),
            `${item.name} never sent initialize`,
          ).pipe(Effect.timeout("10 seconds"))
          yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
          expect(init.method).toBe("initialize")
        }),
      )
    }),
  )

describe("project-code language servers", () => {
  for (const item of cases) untrusted(item)
  for (const item of cases) trustedCase(item)
})
