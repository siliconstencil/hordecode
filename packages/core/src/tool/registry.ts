export * as ToolRegistry from "./registry"

import { ToolOutput, ToolDefinition, type ToolCall, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Scope, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, shell as shellOf, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { BuiltinWorkflow } from "@opencode-ai/workflow/builtin"
import { makeLocationNode } from "../effect/app-node"
import { shellInputSchema, shellWrapSettle } from "./shell-wrap"
import { resolveInvocationStyle, type ToolStyleConfig } from "./invocation-style"

export function renderWorkflowCatalog(): string {
  const list = BuiltinWorkflow.list()
  if (list.length === 0) return ""
  const entries = list.map((w) => {
    const phases = w.phases?.length ? "\n  Phases: " + w.phases.map((p) => p.title).join(" -> ") : ""
    const when = w.whenToUse ? `\n  When to use: ${w.whenToUse}` : ""
    return `- ${w.name}: ${w.description}${when}${phases}`
  })
  return [
    "",
    "## Built-in workflows",
    'These named workflows are available via operation "run" with `name`. When a request matches one, invoke it instead of writing a script from scratch:',
    "",
    ...entries,
    "",
    'Invoke a built-in: workflow({ operation: "run", name: "deep-research", args: "<the refined request>" })',
  ].join("\n")
}

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset, toolStyleCfg?: ToolStyleConfig) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = [], toolStyleCfg) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)

        const shellSettles = new Map<string, (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>>()

        const defs = Array.from(registrations, ([name, registration]) => {
          const toolShell = shellOf(registration.tool)
          const style = resolveInvocationStyle(toolStyleCfg, name)
          const useShell = style === "shell" && toolShell
          if (useShell && toolShell) {
            const normalDef = definition(name, registration.tool)
            const shellDef = new ToolDefinition({
              name,
              description: toolShell.description,
              inputSchema: toJsonSchemaDocument(shellInputSchema),
              outputSchema: normalDef.outputSchema,
            })
            const wrappedSettle = shellWrapSettle(name, toolShell, (call, ctx) =>
              settle(registration.tool, call, ctx),
            )
            shellSettles.set(name, (input) => {
              const ctx = {
                sessionID: input.sessionID,
                agent: input.agent,
                assistantMessageID: input.assistantMessageID,
                toolCallID: input.call.id,
              }
              return wrappedSettle(input.call, ctx).pipe(
                Effect.map((output) => ({ output }) as { output: ToolOutput } | { result: { type: "error"; value: string } }),
                Effect.catchTag("LLM.ToolFailure", (failure) =>
                  Effect.succeed({ result: { type: "error" as const, value: failure.message } } as { output: ToolOutput } | { result: { type: "error"; value: string } }),
                ),
                Effect.flatMap((pending): Effect.Effect<Settlement, ToolOutputStore.Error> => {
                  if ("result" in pending) return Effect.succeed(pending as Settlement)
                  const output = (pending as { output: ToolOutput }).output
                  return resources
                    .bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
                    .pipe(
                      Effect.map((bounded) => {
                        const result = ToolOutput.toResultValue(bounded.output)
                        if (result.type === "error")
                          return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } as Settlement : { result } as Settlement
                        return bounded.outputPaths.length > 0
                          ? { result, output: bounded.output, outputPaths: bounded.outputPaths } as Settlement
                          : { result, output: bounded.output } as Settlement
                      }),
                    )
                }),
              )
            })
            return shellDef
          }
          return definition(name, registration.tool)
        })

        return {
          definitions: defs,
          settle: (input) => {
            const shellSettle = shellSettles.get(input.call.name)
            if (shellSettle) return shellSettle(input)
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

function toJsonSchemaDocument(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
