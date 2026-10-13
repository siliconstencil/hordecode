import path from "path"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Session } from "../session/index"
import { Service as QuestionService, RejectedError, Tool as QuestionTool } from "../question/index"
import { Provider } from "../provider/index"
import { Instance } from "@opencode-ai/project/instance"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { MessageV2 } from "../session/message-v2"
import { MessageID, PartID } from "../session/schema"
import ENTER_DESCRIPTION from "./plan-enter.txt"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: string) {
  for (const item of MessageV2.stream(sessionID as never, { agentID: "*" })) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  metadata: Schema.Struct({
    switched: Schema.Boolean,
    feedback: Schema.String,
  }),
})

const name_plan_enter = "plan_enter"
const name_plan_exit = "plan_exit"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const session = yield* Session.Service
    const question = yield* QuestionService
    const provider = yield* Provider.Service

    yield* tools.register({
      [name_plan_enter]: Tool.make({
        description: ENTER_DESCRIPTION,
        input: Schema.Struct({}),
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
        execute: (_input, ctx) =>
          Effect.gen(function* () {
            if (ctx.agent === "plan") {
              return {
                title: "Already in plan mode",
                output: "You are already in plan mode. This tool is only effective outside of plan mode.",
                metadata: { switched: false, feedback: "" },
              }
            }

            const info = yield* session.get(ctx.sessionID)
            const planPath = path.relative(Instance.worktree, Session.plan(info))
            const answers = yield* question.ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  key: "plan_enter",
                  params: { plan: planPath },
                  question: `Would you like to switch to plan mode for structured planning?`,
                  header: "Plan",
                  options: [
                    { label: "Yes", description: "Switch to plan agent for read-only planning" },
                    { label: "No", description: "Stay in current mode" },
                  ],
                },
              ],
              tool: ctx.toolCallID ? new QuestionTool({ messageID: ctx.assistantMessageID as never, callID: ctx.toolCallID }) : undefined,
            })

            const answer = answers[0]?.[0]
            if (answer === "No") return yield* new RejectedError({})

            if (answer !== "Yes") {
              return {
                title: "User provided feedback",
                output: `User chose not to switch yet and provided feedback: ${answer}`,
                metadata: { switched: false, feedback: String(answer) },
              }
            }

            const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

            const msg: MessageV2.User = {
              id: MessageID.ascending(),
              sessionID: ctx.sessionID as never,
              role: "user",
              time: { created: Date.now() },
              agent: "plan",
              model,
            }
            yield* session.updateMessage(msg)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: ctx.sessionID as never,
              type: "text",
              text: `Switched to plan mode. Create a plan at ${planPath}`,
              synthetic: true,
            } satisfies MessageV2.TextPart)

            return {
              title: "Switching to plan agent",
              output: "User approved switching to plan agent. Wait for further instructions.",
              metadata: { switched: true, feedback: "" },
            }
          }).pipe(Effect.mapError((e) => new Tool.Failure({ message: e instanceof Error ? e.message : String(e) }))),
      }),

      [name_plan_exit]: Tool.make({
        description: EXIT_DESCRIPTION,
        input: Schema.Struct({}),
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
        execute: (_input, ctx) =>
          Effect.gen(function* () {
            if (ctx.agent !== "plan") {
              return {
                title: "Not in plan mode",
                output: "You are not in plan mode. This tool is only effective in plan mode.",
                metadata: { switched: false, feedback: "" },
              }
            }

            const info = yield* session.get(ctx.sessionID)
            const planPath = path.relative(Instance.worktree, Session.plan(info))
            const answers = yield* question.ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  key: "plan_exit",
                  params: { plan: planPath },
                  question: `Plan at ${planPath} is complete. Would you like to switch to the build agent and start implementing?`,
                  header: "Plan",
                  options: [
                    { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                    { label: "No", description: "Stay with plan agent to continue refining the plan" },
                  ],
                },
              ],
              tool: ctx.toolCallID ? new QuestionTool({ messageID: ctx.assistantMessageID as never, callID: ctx.toolCallID }) : undefined,
            })

            const answer = answers[0]?.[0]
            if (answer === "No") return yield* new RejectedError({})

            if (answer !== "Yes") {
              return {
                title: "User provided feedback",
                output: `User chose not to switch yet and provided feedback: ${answer}`,
                metadata: { switched: false, feedback: String(answer) },
              }
            }

            const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

            const msg: MessageV2.User = {
              id: MessageID.ascending(),
              sessionID: ctx.sessionID as never,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model,
            }
            yield* session.updateMessage(msg)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: ctx.sessionID as never,
              type: "text",
              text: `The plan at ${planPath} has been approved, you can now edit files. Execute the plan`,
              synthetic: true,
            } satisfies MessageV2.TextPart)

            return {
              title: "Switching to build agent",
              output: "User approved switching to build agent. Wait for further instructions.",
              metadata: { switched: true, feedback: "" },
            }
          }).pipe(Effect.mapError((e) => new Tool.Failure({ message: e instanceof Error ? e.message : String(e) }))),
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "plan",
  layer,
  // @ts-expect-error -- CheckDependencies type inference issue, runtime correct
  deps: [ToolRegistry.node],
})
export * as PlanTool from "./plan"
