import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@opencode-ai/core/id/id"
import { ZodOverride } from "@opencode-ai/core/util/effect-zod"
import { Newtype } from "@opencode-ai/core/util/schema"

export class QuestionID extends Newtype<QuestionID>()(
  "QuestionID",
  Schema.String.annotate({ [ZodOverride]: Identifier.schema("question") }),
) {
  static ascending(id?: string): QuestionID {
    return this.make(Identifier.ascending("question", id))
  }

  static readonly zod = Identifier.schema("question") as unknown as z.ZodType<QuestionID>
}
