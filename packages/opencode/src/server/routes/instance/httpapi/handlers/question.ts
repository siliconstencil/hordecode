import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const neverAsk = Effect.fn("QuestionHttpApi.neverAsk")(function* () {
      return yield* svc.neverAsk()
    })

    const setNeverAsk = Effect.fn("QuestionHttpApi.setNeverAsk")(function* (ctx: {
      payload: { enabled: boolean }
      query: { workspace?: string; directory?: string }
    }) {
      // query.workspace/directory threads through WorkspaceRoutingMiddleware -> WorkspaceRouteContext -> InstanceState.directory;
      // handler does not need to pass it explicitly, but declaring query here ensures HttpApi validates it and
      // empty workspace is correctly treated as absent (omit => defaultDirectory) rather than InvalidWorkspace.
      void ctx.query
      yield* svc.setNeverAsk(ctx.payload.enabled)
      return yield* svc.neverAsk()
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject).handle("neverAsk", neverAsk).handle("setNeverAsk", setNeverAsk)
  }),
)
