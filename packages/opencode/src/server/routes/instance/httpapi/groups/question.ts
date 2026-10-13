import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { QuestionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/question"
const ReplyPayload = Schema.Struct({
  answers: Schema.Array(Question.Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
})

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Question.Request), "List of pending questions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "List pending questions",
            description: "Get all pending question requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: QuestionID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Question answered successfully"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reply",
            summary: "Reply to question request",
            description: "Provide answers to a question request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
          params: { requestID: QuestionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Question rejected successfully"),
          error: [HttpApiError.BadRequest, QuestionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reject",
            summary: "Reject question request",
            description: "Reject a question request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.get("neverAsk", `${root}/never-ask`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Current never-ask state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.neverAsk",
            summary: "Get never-ask state",
            description: "Get current never-ask state.",
          }),
        ),
        HttpApiEndpoint.post("setNeverAsk", `${root}/never-ask`, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            enabled: Schema.Boolean,
          }),
          success: described(Schema.Boolean, "Updated never-ask state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.setNeverAsk",
            summary: "Set never-ask state",
            description:
              "Enable or disable never-ask: the question tool stays visible but returns a [Never-Ask] directive so the model resolves decisions itself.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "question",
          description: "Question routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
