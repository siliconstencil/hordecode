import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const nope = yield* question.neverAsk()
          if (nope) {
            const autoAnswer = "[Never-Ask] The model will decide autonomously"
            return {
              title: `Auto-resolved ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
              output:
                "[Never-Ask] No user is available to answer (never-ask mode is on). " +
                "Re-evaluate the options you just proposed for unattended/headless execution — " +
                "prefer text-only, non-interactive, minimal-scope paths and avoid anything that needs a GUI or the user to be present. " +
                "Pick the best option yourself and continue. " +
                "IMPORTANT: You MUST explicitly state which option you chose and why in your response text (not just in thinking) — " +
                "the user will review the conversation history later and needs to see what you decided without expanding thinking blocks. " +
                "This applies only to this question; never-ask may be turned off later, so keep using the question tool at future decision points (the user may have returned).",
              metadata: {
                answers: params.questions.map(() => [autoAnswer]),
              },
            }
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
