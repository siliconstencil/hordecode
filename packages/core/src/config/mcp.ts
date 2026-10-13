export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Server).pipe(Schema.optional),
}) {}

// --- Reconciled additions ---

export type Origin = {
  type: "opencode" | "claude"
  source: string
}

// --- fromClaude (Claude Code MCP import, required by config.ts line 729) ---

import { isRecord } from "@opencode-ai/core/util/record"

const remoteTypes = new Set(["http", "streamable-http", "remote"])
const localTypes = new Set(["stdio", "local"])

export function fromClaude(name: string, input: unknown): { config: Local | Remote } | { warning: string } {
  if (!isRecord(input)) return { warning: `skipped Claude Code MCP server "${name}"; server config is not an object.` }

  if (input.type === "sse") {
    return { warning: `skipped Claude Code MCP server "${name}"; unsupported transport "sse".` }
  }

  if (input.args !== undefined && !Array.isArray(input.args)) {
    return { warning: `skipped Claude Code MCP server "${name}"; args is not an array.` }
  }

  const args = Array.isArray(input.args) ? input.args : []
  if (!args.every((item: unknown) => typeof item === "string")) {
    return { warning: `skipped Claude Code MCP server "${name}"; args must contain only strings.` }
  }

  const enabled = input.disabled === true ? false : input.enabled === false ? false : true
  const environment = isRecord(input) && typeof input.environment === "object" && input.environment !== null
    ? Object.fromEntries(Object.entries(input.environment).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined
  const timeout = typeof input.timeout === "number" ? input.timeout : undefined
  const type = typeof input.type === "string" ? input.type : undefined

  if (typeof input.command === "string" && (!type || localTypes.has(type))) {
    return {
      config: {
        type: "local",
        command: [input.command, ...args],
        ...(environment && { environment }),
        disabled: !enabled,
        ...(timeout !== undefined && { timeout: { startup: timeout, request: timeout } }),
      },
    }
  }

  if (input.command !== undefined) {
    return { warning: `skipped Claude Code MCP server "${name}"; command is not a string.` }
  }

  if (typeof input.url === "string" && (!type || remoteTypes.has(type))) {
    const headers = isRecord(input) && typeof input.headers === "object" && input.headers !== null
      ? Object.fromEntries(Object.entries(input.headers).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined
    return {
      config: {
        type: "remote",
        url: input.url,
        disabled: !enabled,
        ...(headers && { headers }),
        ...(timeout !== undefined && { timeout: { startup: timeout, request: timeout } }),
      },
    }
  }

  if (input.url !== undefined) {
    return { warning: `skipped Claude Code MCP server "${name}"; url is not a string.` }
  }

  if (type && !localTypes.has(type) && !remoteTypes.has(type)) {
    return { warning: `skipped Claude Code MCP server "${name}"; unsupported transport "${type}".` }
  }

  return { warning: `skipped Claude Code MCP server "${name}"; missing command or url.` }
}
