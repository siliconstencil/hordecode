import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@opencode-ai/core/id/id"
import { ZodOverride } from "@opencode-ai/core/util/effect-zod"
import { Newtype } from "@opencode-ai/core/util/schema"

export class PermissionID extends Newtype<PermissionID>()(
  "PermissionID",
  Schema.String.annotate({ [ZodOverride]: Identifier.schema("permission") }),
) {
  static ascending(id?: string): PermissionID {
    return this.make(Identifier.ascending("permission", id))
  }

  static readonly zod = Identifier.schema("permission") as unknown as z.ZodType<PermissionID>
}
