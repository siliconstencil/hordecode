import { Effect, Schema } from "effect"
import { History } from "@opencode-ai/core/history"
import DESCRIPTION from "./history.txt"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import { Agent } from "../agent/agent"
import type { Kind } from "@opencode-ai/core/history/extract"

const AROUND_MAX_BYTES = 20 * 1024

export const Parameters = Schema.Struct({
  operation: Schema.String.annotate({ description: "search: FTS BM25; around: pull message context" }),
  query: Schema.optional(Schema.String).annotate({
    description: "FTS query (BM25 over text/tool bodies). Required for operation=search.",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "Default project." }),
  session_id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Array(Schema.String)),
  tool_name: Schema.optional(Schema.String).annotate({
    description: "Filter to a specific tool (e.g. Bash, Read)",
  }),
  time_after: Schema.optional(Schema.Number).annotate({ description: "Unix ms" }),
  time_before: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number).annotate({ description: "Max 50, default 10" }),
  message_id: Schema.optional(Schema.String).annotate({
    description: "Anchor message id. Required for operation=around.",
  }),
  before: Schema.optional(Schema.Number).annotate({ description: "Default 5" }),
  after: Schema.optional(Schema.Number).annotate({ description: "Default 5" }),
})

export const HistoryTool = Tool.define<typeof Parameters, { count?: number; truncated?: boolean; outputPath?: string }, History.Service | Truncate.Service | Agent.Service>(
  "history",
  Effect.gen(function* () {
    const history = yield* History.Service
    const truncate = yield* Truncate.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (args.operation === "search") {
            if (!args.query) {
              return {
                title: "History search: missing query",
                output: "operation=search requires a `query` argument.",
                metadata: { count: 0 },
              }
            }
            const hits = yield* history.search({
              query: args.query,
              scope: args.scope as "project" | "global" | undefined,
              session_id: args.session_id,
              kind: args.kind as Kind[] | undefined,
              tool_name: args.tool_name,
              time_after: args.time_after,
              time_before: args.time_before,
              limit: args.limit,
            })
            if (hits.length === 0) {
              return {
                title: "History search: 0 matches",
                output: `0 matches for "${args.query}". Try memory search if you haven't, or broaden the query.`,
                metadata: { count: 0 },
              }
            }
            const lines = [`Found ${hits.length} match${hits.length === 1 ? "" : "es"}:`, ""]
            for (const h of hits) {
              const kindLabel = h.tool_name ? `${h.kind} . ${h.tool_name}` : h.kind
              lines.push(`### ${h.session_id} ${h.message_id}  (${kindLabel})`)
              lines.push(`Time: ${new Date(h.time_created).toISOString()}, Score: ${h.score.toFixed(3)}`)
              lines.push(h.snippet)
              lines.push("")
            }
            return {
              title: `History search: ${hits.length} match${hits.length === 1 ? "" : "es"}`,
              output: lines.join("\n"),
              metadata: { count: hits.length },
            }
          }

          if (!args.message_id) {
            return {
              title: "History around: missing message_id",
              output: "operation=around requires a `message_id` argument.",
              metadata: { count: 0 },
            }
          }
          const around = yield* history.around({
            message_id: args.message_id,
            before: args.before,
            after: args.after,
          })
          if (around.messages.length === 0) {
            return {
              title: "History around: anchor not found",
              output: `No message with id ${args.message_id}.`,
              metadata: { count: 0 },
            }
          }
          const lines = [
            `Session ${around.session_id}, ${around.messages.length} messages (anchor ${args.message_id}):`,
            "",
          ]
          for (const m of around.messages) {
            const prefix = m.matched ? ">>>" : "---"
            lines.push(`${prefix} ${m.message_id} (${new Date(m.time_created).toISOString()})`)
            for (const p of m.parts) {
              const head = p.tool_name ? `${p.type} (${p.tool_name})` : p.type
              lines.push(`  ${p.role} . ${head}:`)
              lines.push(p.text.split("\n").map((l) => `    ${l}`).join("\n"))
            }
            lines.push("")
          }
          const rawOutput = lines.join("\n")
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(rawOutput, { maxBytes: AROUND_MAX_BYTES }, agent)
          return {
            title: `History around ${args.message_id}`,
            output: truncated.content,
            metadata: {
              count: around.messages.length,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
