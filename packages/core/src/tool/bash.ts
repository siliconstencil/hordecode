export * as BashTool from "./bash"

import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Language, type Node } from "web-tree-sitter"
import { BashArity } from "../permission/arity"
import { Log } from "../util"
import { lazy } from "../util/lazy"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Flag } from "../flag/flag"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { BashInteractive } from "./bash-interactive"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { clean } from "./bash_token_efficient_pipeline"
import { cleanHeuristic } from "./bash_token_efficient_heuristic"

// Deferred parity items (locked by test/tool-bash.test.ts "keeps locked deferred parity TODOs visible"):
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
  interactive: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Set to true when the command requires user interaction (password input, y/N confirmation, SSH key passphrase, etc). The terminal will be handed to the user for direct interaction.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  deletes: Set<string>
}

// ---------------------------------------------------------------------------
// Shell and command constants
// ---------------------------------------------------------------------------

const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
])

const GIT_DESTRUCTIVE = new Map<string, Set<string>>([
  ["reset", new Set(["--hard"])],
  ["clean", new Set(["-f", "-ff", "-fd", "-fdx", "-df", "-dfx", "-fx", "--force"])],
  ["branch", new Set(["-D", "--delete"])],
  ["tag", new Set(["-d", "--delete"])],
  ["worktree", new Set(["remove"])],
  ["push", new Set(["--force", "-f"])],
  ["stash", new Set(["drop", "clear"])],
])

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = Log.create({ service: "bash-tool" })

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timeout) return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command timed out before completion.`
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

// ---------------------------------------------------------------------------
// WASM tree-sitter parser singleton
// ---------------------------------------------------------------------------

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  return { bash }
})

// ---------------------------------------------------------------------------
// AST traversal helpers
// ---------------------------------------------------------------------------

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function isDelete(tokens: string[], ps: boolean) {
  if (tokens.length === 0) return false
  const head = ps ? tokens[0].toLowerCase() : tokens[0]
  if (DELETE_COMMANDS.has(head)) return true
  if (head === "git" && tokens.length >= 2) {
    const sub = tokens[1]
    const flags = GIT_DESTRUCTIVE.get(sub)
    if (!flags) return false
    if (flags.size === 0) return true
    return tokens.slice(2).some((tok) => flags.has(tok))
  }
  return false
}

const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

// ---------------------------------------------------------------------------
// Parse and collect
// ---------------------------------------------------------------------------

const parse = Effect.fn("BashTool.parse")(function* (command: string) {
  const tree = yield* Effect.promise(() => parser().then((p) => p.bash.parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

const collect = Effect.fn("BashTool.collect")(function* (
  root: Node,
  cwd: string,
  ps: boolean,
  shell: string,
  fs: FSUtil.Interface,
) {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
    deletes: new Set<string>(),
  }

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && FILES.has(cmd)) {
      for (const arg of pathArgs(command, ps)) {
        const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
        const file = text && prefix(text)
        if (!file || dynamic(file, ps)) continue
        const next = ps ? provider(file) : file
        if (!next) continue
        const resolved = path.resolve(cwd, next)
        if (!resolved || FSUtil.contains(cwd, resolved)) continue
        const isDir = yield* fs.isDir(resolved)
        scan.dirs.add(isDir ? resolved : path.dirname(resolved))
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }

    if (isDelete(tokens, ps)) scan.deletes.add(source(node))
  }

  return scan
})

// ---------------------------------------------------------------------------
// Tool layer
// ---------------------------------------------------------------------------

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const bashInteractive = yield* BashInteractive.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; command-argument paths are scanned via tree-sitter AST for precise permission prompts. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()
              const shellName = path.basename(shell)
              const ps = PS.has(shellName)

              // AST-based command analysis for permission scanning
              const root = yield* parse(input.command)
              const scan = yield* collect(root, target.canonical, ps, shell, fs)

              // Advisory warnings from external directory references in command args
              const warnings = [...scan.dirs].map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )

              // Delete commands get a forced-ask permission check
              if (scan.deletes.size > 0) {
                yield* permission.assert({
                  action: "bash_delete",
                  resources: [...scan.deletes],
                  save: [],
                  metadata: { command: input.command, deletes: [...scan.deletes] },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              } else {
                yield* permission.assert({
                  action: name,
                  resources: scan.patterns.size > 0 ? [...scan.patterns] : [input.command],
                  save: scan.always.size > 0 ? [...scan.always] : [input.command],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              }

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              // Interactive mode: hand the terminal to the user for direct interaction
              if (input.interactive) {
                const interactiveResult = yield* bashInteractive.request({
                  command: input.command,
                  cwd: target.canonical,
                  env: process.env as Record<string, string>,
                  description: input.command.slice(0, 80),
                })
                return {
                  exit: interactiveResult.exitCode,
                  output:
                    interactiveResult.output ||
                    `(interactive command completed with exit code ${interactiveResult.exitCode})`,
                  truncated: false,
                }
              }

              const command = ChildProcess.make(input.command, [], {
                cwd: target.canonical,
                shell,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const result = yield* appProcess
                .run(command, {
                  combineOutput: true,
                  timeout: Duration.millis(timeout),
                  maxOutputBytes: MAX_CAPTURE_BYTES,
                })
                .pipe(
                  Effect.catchTag("AppProcessError", (error) =>
                    isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                  ),
                )
              if (!result) {
                return {
                  output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                  truncated: false,
                  timeout: true,
                  ...(warnings.length ? { warnings } : {}),
                }
              }

              const rawOutput = result.output?.toString("utf8") || "(no output)"
              const notice = result.outputTruncated
                ? "[output capture truncated at the in-memory safety limit]"
                : undefined

              let output = rawOutput
              if (!result.outputTruncated && Flag.HORDECODE_EXPERIMENTAL_TOKEN_EFFICIENCY) {
                const cleaned = clean(output, { command: input.command })
                if (cleaned.bytesOut < cleaned.bytesIn) {
                  output = cleaned.text
                }
                if (Flag.HORDECODE_EXPERIMENTAL_TOKEN_EFFICIENCY_HEURISTIC) {
                  const heur = cleanHeuristic(output, { command: input.command })
                  if (heur.bytesOut < heur.bytesIn) {
                    output = heur.text
                  }
                }
              }

              return {
                exit: result.exitCode,
                output: notice ? `${output}\n\n${notice}` : output,
                truncated: result.outputTruncated === true,
                ...(warnings.length ? { warnings } : {}),
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to execute command: ${input.command}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    AppProcess.node,
    Config.node,
    PermissionV2.node,
    BashInteractive.node,
  ],
})
