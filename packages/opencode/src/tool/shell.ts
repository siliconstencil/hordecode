import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import { realpathSync } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"
import { withoutCredentials } from "@opencode-ai/core/util/credential-env"
import { Git } from "@/git"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import * as SandboxShell from "@/sandbox/shell"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { ProtectedPath } from "@/permission/protected-path"
import * as BashInteractive from "./bash-interactive"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
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
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

// Irreversible file/directory removal commands. Names are matched
// case-insensitively for PowerShell; bash is case-sensitive.
const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  // Windows / PowerShell removal verbs and their common aliases. `remove-item`
  // is the canonical verb; `ri`, `rd`, `del`, `erase` are aliases.
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
])

// git subcommands that destroy history, working tree state, or remote branches.
// Value is the set of tokens (flag or subcommand keyword) that must appear
// anywhere in the argv for the invocation to count as destructive. An empty
// set means the subcommand is destructive on its own.
const GIT_DESTRUCTIVE = new Map<string, Set<string>>([
  ["reset", new Set(["--hard"])],
  ["clean", new Set(["-f", "-ff", "-fd", "-fdx", "-df", "-dfx", "-fx", "--force"])],
  ["branch", new Set(["-D", "--delete"])],
  ["tag", new Set(["-d", "--delete"])],
  ["worktree", new Set(["remove"])],
  ["push", new Set(["--force", "-f"])],
  ["stash", new Set(["drop", "clear"])],
])

// macOS reports /tmp and /var as symlinks into /private, so containment must be
// checked on REALPATHS: a lexical check would reject the literal "/tmp/x" even
// though it lives inside the canonical os.tmpdir() jail. "/tmp" is listed
// alongside os.tmpdir() because on macOS they are DIFFERENT directories
// (/private/tmp vs /private/var/folders/...). Mirrors tool-script.ts's jail.
function tmpRoots() {
  return [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
}

function realpathBestEffort(p: string) {
  let cur = p
  let suffix = ""
  while (true) {
    try {
      return path.join(realpathSync.native(cur), suffix)
    } catch {
      suffix = suffix ? path.join(path.basename(cur), suffix) : path.basename(cur)
      const parent = path.dirname(cur)
      if (parent === cur) return p
      cur = parent
    }
  }
}

// A path counts as inside the project only when its real location is too: a symlink in the worktree that points
// elsewhere must still ask for the external directory.
function insideProject(resolved: string, instance: InstanceContext) {
  if (!containsPath(resolved, instance)) return false
  return containsPath(realpathBestEffort(resolved), {
    ...instance,
    directory: realpathBestEffort(instance.directory),
    worktree: instance.worktree === "/" ? "/" : realpathBestEffort(instance.worktree),
  })
}

function insideTmp(resolved: string) {
  const abs = realpathBestEffort(resolved)
  return tmpRoots()
    .map(realpathBestEffort)
    .some((root) => abs !== root && abs.startsWith(root + path.sep))
}

// Returns true when `tokens` (the flat argv of a single command node) invokes
// an irreversible deletion -- either a direct removal command (rm, remove-item,
// ...) or a destructive git subcommand (git reset --hard, git clean -f, ...).
// `ps` toggles PowerShell case-insensitive matching.
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

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  protected: Set<string>
  patterns: Set<string>
  always: Set<string>
  deletes: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

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

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

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

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
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

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

// Secondary confirmation for irreversible deletion commands. Uses its own
// permission type ("bash_delete"), which the Permission layer flags as
// forced-ask: no `allow` rule (not even a broad `"*": allow`) can silently
// pre-approve it -- only an explicit `deny` blocks. `always` is empty because
// a persisted "allow all deletes" rule is exactly what forced-ask exists to
// prevent. The delete UI shows the full command, so this ask FULLY replaces
// the regular bash/external_directory prompts when it fires (see the caller
// below) -- deletion is authorized in a single, unambiguous confirmation.
const askDelete = Effect.fn("ShellTool.askDelete")(function* (
  ctx: Tool.Context,
  scan: Scan,
  command: string,
) {
  const patterns = Array.from(scan.deletes)
  yield* ctx.ask({
    permission: "bash_delete",
    patterns,
    always: [],
    metadata: { command, deletes: patterns },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
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
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const gitSvc = yield* Git.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    // Layer-2 floor for git authorship: an agent may create a worktree/clone or
    // commit in an ad-hoc dir via this shell tool, bypassing Worktree.setup()'s
    // per-worktree local-config fix. Propagate the project repo's own identity so
    // those commits are attributed the same way a commit in the project repo is.
    //
    // Behavioral contract of this floor and its cache:
    //   - It only ever PROPAGATES an identity the repo itself already resolves.
    //     It never invents one: when the repo has no identity -- or there is no
    //     repo at all -- nothing is injected and git resolves authorship itself
    //     (config, then `EMAIL`, then its own `user@hostname` autodetect, then
    //     its own error). A hardcoded substitute would misattribute the commit
    //     AND pre-empt resolution paths `git config` cannot see.
    //   - It is delivered as GIT_AUTHOR_*/GIT_COMMITTER_* ENV, and git gives env
    //     vars precedence OVER `user.name`/`user.email` config -- including the
    //     config of some OTHER repo the command happens to run in. That is
    //     exactly why an unresolved field must inject nothing rather than a
    //     placeholder: a placeholder would outrank that repo's correct config.
    //   - Because the resolved value is memoized per worktree path for the
    //     lifetime of the process, a `git config user.name ...` performed
    //     mid-session is NOT picked up until the process restarts.
    //   - Operator-set GIT_AUTHOR_*/GIT_COMMITTER_* still win: shellEnv only
    //     fills the vars that are absent from process.env (see below).
    //
    // resolveGitIdentity and gitIdentityCache live in this outer setup block,
    // not inside shellEnv, precisely so the cache persists across every call.
    const gitIdentityCache = new Map<string, { name?: string; email?: string }>()
    const resolveGitIdentity = Effect.fn("ShellTool.resolveGitIdentity")(function* (worktree: string) {
      const cached = gitIdentityCache.get(worktree)
      if (cached) return cached
      // Non-git projects set worktree to "/". There is no project repo whose
      // identity we could propagate, and whatever repo a git command does run in
      // has its own config -- which injected env would override. Inject nothing.
      if (worktree === "/") {
        const none: { name?: string; email?: string } = {}
        gitIdentityCache.set(worktree, none)
        return none
      }
      const name = (yield* gitSvc.run(["config", "user.name"], { cwd: worktree })).text().trim()
      const email = (yield* gitSvc.run(["config", "user.email"], { cwd: worktree })).text().trim()
      const identity = { ...(name ? { name } : {}), ...(email ? { email } : {}) }
      gitIdentityCache.set(worktree, identity)
      return identity
    })

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    // Whether EVERY delete in this command line is a plain removal confined to a
    // temp root -- the one case where the forced-ask confirmation is skipped.
    //
    // Fails closed on purpose, in four ways. Any single miss means "ask":
    //   1. Only DELETE_COMMANDS qualify. Destructive git subcommands
    //      (reset --hard, push --force, stash drop, ...) act on repository state,
    //      not on a path in tmp, so they can never earn the exemption.
    //   2. A delete with no path arguments cannot be shown to be tmp-scoped.
    //   3. An argument `argPath` declines to resolve -- a glob, a `$VAR`, a `$(...)`
    //      substitution (see `dynamic`) -- is UNKNOWN, and unknown is not tmp.
    //      This is the load-bearing case: `rm -rf $BUILD_DIR/*` must still ask.
    //   4. A resolved path outside a temp root, including a root itself
    //      (`insideTmp` requires a strict descendant, so `rm -rf /tmp` asks).
    //   5. A path inside the PROJECT, even when the project itself lives under a
    //      temp root (a real configuration -- the test fixtures do exactly this).
    //      Scratch space earns the exemption because it holds no durable work;
    //      a checkout's own files are durable wherever they happen to sit.
    const tmpOnlyDelete = Effect.fn("ShellTool.tmpOnlyDelete")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        if (!isDelete(tokens, ps)) continue
        const head = ps ? tokens[0]?.toLowerCase() : tokens[0]
        if (!head || !DELETE_COMMANDS.has(head)) return false
        const args = pathArgs(command, ps)
        if (args.length === 0) return false
        for (const arg of args) {
          const resolved = yield* argPath(arg, cwd, ps, shell)
          if (!resolved || !insideTmp(resolved) || containsPath(resolved, instance)) return false
        }
      }
      return true
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        protected: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
        deletes: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || insideProject(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }

        if (isDelete(tokens, ps)) scan.deletes.add(source(node))

        for (const word of tokens.slice(1)) {
          const file = ProtectedPath.matchWord(word, cwd)
          if (file) scan.protected.add(file)
        }
      }

      for (const node of root.descendantsOfType("file_redirect")) {
        const target = node?.childForFieldName("destination")
        const file = target && ProtectedPath.matchWord(target.text, cwd)
        if (file) scan.protected.add(file)
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const instanceCtx = yield* InstanceState.context
      const identity = yield* resolveGitIdentity(instanceCtx.worktree)
      // Only fill vars the operator hasn't already set, so an explicit
      // GIT_AUTHOR_* in the environment still wins over our floor -- and only
      // fields the repo itself resolved, so an unresolved field is left for git.
      const gitFloor: Record<string, string> = {}
      if (identity.name && !process.env["GIT_AUTHOR_NAME"]) gitFloor["GIT_AUTHOR_NAME"] = identity.name
      if (identity.email && !process.env["GIT_AUTHOR_EMAIL"]) gitFloor["GIT_AUTHOR_EMAIL"] = identity.email
      if (identity.name && !process.env["GIT_COMMITTER_NAME"]) gitFloor["GIT_COMMITTER_NAME"] = identity.name
      if (identity.email && !process.env["GIT_COMMITTER_EMAIL"]) gitFloor["GIT_COMMITTER_EMAIL"] = identity.email
      // withoutCredentials: this env goes to agent-authored commands.
      return {
        ...withoutCredentials(process.env),
        // Python ignores the console code page when stdout is a pipe and falls
        // back to the ANSI code page (GBK on zh-CN), producing mojibake. Force
        // UTF-8 for child Python processes on Windows.
        ...(process.platform === "win32" ? { PYTHONIOENCODING: "utf-8" } : {}),
        // Git authorship floor. Placed after process.env so the spread order
        // reads naturally, but it can never clobber an operator value: gitFloor
        // only ever holds keys that were absent from process.env. A plugin's
        // extra.env comes last and so can still override the floor.
        ...gitFloor,
        ...extra.env,
      }
    })

    // Sandbox mode comes from the process environment and defaults to "off", which spawns exactly as before.
    const launch = Effect.fn("ShellTool.launch")(function* (input: {
      shell: string
      command: string
      cwd: string
      env: NodeJS.ProcessEnv
    }) {
      const instanceCtx = yield* InstanceState.context
      const prepared = yield* Effect.promise(async () => {
        try {
          return {
            value: await SandboxShell.shared.prepare({
              settings: SandboxShell.settings(),
              shell: input.shell,
              command: input.command,
              cwd: input.cwd,
              worktree: instanceCtx.worktree === "/" ? instanceCtx.directory : instanceCtx.worktree,
            }),
          }
        } catch (error) {
          return { error }
        }
      })
      if ("error" in prepared) throw prepared.error
      if (prepared.value.warning) yield* Effect.logWarning(prepared.value.warning)
      const wrapped = prepared.value.command
      if (!wrapped) return cmd(input.shell, input.command, input.cwd, input.env)
      return ChildProcess.make(wrapped.file, wrapped.args, {
        cwd: input.cwd,
        env: input.env,
        stdin: "ignore",
        detached: process.platform !== "win32",
      })
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(yield* launch(input))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              // Session cwd (change_directory) is the base directory; MiMo Code 0.1.11 tool/bash.ts:841.
              const base = SessionCwd.get(ctx.sessionID, instanceCtx.directory)
              const cwd = params.workdir ? yield* resolvePath(params.workdir, base, shell) : base
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ProtectedPath.assert(ctx, scan.protected)
                  // Delete-containing commands are authorized by askDelete alone --
                  // the delete UI shows the full command (including any external
                  // paths it touches), so a separate bash/external_directory
                  // prompt would just be a second confirmation of the same thing.
                  // Two bypasses fall back to the regular ask (where a `bash: deny`
                  // rule still blocks): the instance's auto-approve-delete state
                  // trusts every delete (defaults to false when absent), and
                  // `tmpOnlyDelete` trusts one whose every target is provably inside
                  // a temp root -- scratch space holds no durable user work, and that
                  // check fails closed on anything it cannot resolve.
                  const skipDeleteAsk =
                    scan.deletes.size === 0 ||
                    (ctx.autoApproveDelete ? yield* ctx.autoApproveDelete() : false) ||
                    (yield* tmpOnlyDelete(tree.rootNode, cwd, ps, shell, instanceCtx))
                  if (!skipDeleteAsk) {
                    yield* askDelete(ctx, scan, params.command)
                  } else {
                    yield* ask(ctx, scan, params)
                  }
                }),
              )

              // Interactive mode: hand the terminal to the user for direct
              // interaction (password input, y/N confirmation, SSH passphrase).
              // The request is parked in BashInteractive until a client replies.
              if (params.interactive) {
                const env = yield* shellEnv(ctx, cwd)
                const description = params.description ?? params.command
                yield* ctx.metadata({
                  metadata: {
                    output: "(waiting for user interaction...)",
                    description,
                  },
                })
                const interactiveResult = yield* Effect.tryPromise(() =>
                  BashInteractive.request({
                    command: params.command,
                    cwd,
                    env: env as Record<string, string>,
                    description,
                  }),
                ).pipe(Effect.orDie)
                return {
                  title: description,
                  metadata: {
                    output: interactiveResult.output || "(interactive command completed)",
                    exit: interactiveResult.exitCode,
                    truncated: false,
                  },
                  output:
                    interactiveResult.output ||
                    `(interactive command completed with exit code ${interactiveResult.exitCode})`,
                }
              }

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
