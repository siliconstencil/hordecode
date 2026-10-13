import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ClaudeImport } from "@opencode-ai/core/session/claude-import"
import { CodexImport } from "@opencode-ai/core/session/codex-import"
import { OpencodeImport } from "@opencode-ai/core/session/opencode-import"
import { ExternalImport } from "@opencode-ai/core/session/external-import"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionImportClaudeCommand)
      .command(SessionImportCodexCommand)
      .command(SessionImportOpencodeCommand)
      .command(SessionImportAllCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionImportClaudeCommand = cmd({
  command: "import-claude",
  describe: "import Claude Code sessions (~/.claude/projects) into hordecode",
  builder: (yargs) =>
    yargs.option("force", {
      describe: "re-sync every session, ignoring the mtime cache",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const stats = await ClaudeImport.run({ force: args.force })
    UI.println(
      `Claude import: scanned ${stats.scanned}, imported ${stats.imported}, resynced ${stats.resynced}, skipped ${stats.skipped}` +
        (stats.errors.length ? `, errors ${stats.errors.length}` : ""),
    )
    for (const err of stats.errors) UI.error(err)
  },
})

export const SessionImportCodexCommand = cmd({
  command: "import-codex",
  describe: "import Codex CLI sessions (~/.codex/sessions) into hordecode",
  builder: (yargs) =>
    yargs.option("force", {
      describe: "re-sync every session, ignoring the mtime cache",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const stats = await CodexImport.run({ force: args.force })
    UI.println(
      `Codex import: scanned ${stats.scanned}, imported ${stats.imported}, resynced ${stats.resynced}, skipped ${stats.skipped}` +
        (stats.errors.length ? `, errors ${stats.errors.length}` : ""),
    )
    for (const err of stats.errors) UI.error(err)
  },
})

export const SessionImportOpencodeCommand = cmd({
  command: "import-opencode",
  describe: "import opencode sessions into hordecode",
  builder: (yargs) =>
    yargs.option("force", {
      describe: "re-sync every session, ignoring the mtime cache",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const stats = await OpencodeImport.run({ force: args.force })
    UI.println(
      `opencode import: scanned ${stats.scanned}, imported ${stats.imported}, resynced ${stats.resynced}, skipped ${stats.skipped}` +
        (stats.errors.length ? `, errors ${stats.errors.length}` : ""),
    )
    for (const err of stats.errors) UI.error(err)
  },
})

export const SessionImportAllCommand = cmd({
  command: "import",
  describe: "import sessions from external sources (Claude Code, Codex, opencode)",
  builder: (yargs) =>
    yargs
      .option("source", {
        alias: "s",
        describe: "limit to one or more sources (cc, codex, opencode); repeat the flag for multiple",
        type: "string",
        choices: ["cc", "codex", "opencode"],
        array: true,
      })
      .option("force", {
        describe: "re-sync every session, ignoring the mtime cache",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    const sources = (Array.isArray(args.source) ? args.source : args.source ? [args.source] : undefined) as
      | Array<"cc" | "codex" | "opencode">
      | undefined
    const result = await ExternalImport.runAll({ sources, force: args.force })
    for (const source of ["cc", "codex", "opencode"] as const) {
      const stats = result[source]
      UI.println(
        `${source} import: scanned ${stats.scanned}, imported ${stats.imported}, resynced ${stats.resynced}, skipped ${stats.skipped}` +
          (stats.errors.length ? `, errors ${stats.errors.length}` : ""),
      )
      for (const err of stats.errors) UI.error(err)
    }
  },
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
