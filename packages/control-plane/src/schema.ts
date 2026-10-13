import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@opencode-ai/core/id/id"
import { ZodOverride } from "@opencode-ai/core/util/effect-zod"
import { withStatics } from "@opencode-ai/core/util/schema"

const workspaceIdSchema = Schema.String.annotate({ [ZodOverride]: Identifier.schema("workspace") }).pipe(
  Schema.brand("WorkspaceV2.ID"),
)

export type WorkspaceID = typeof workspaceIdSchema.Type

export const WorkspaceID = workspaceIdSchema.pipe(
  withStatics((schema: typeof workspaceIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("workspace", id)),
    zod: Identifier.schema("workspace").pipe(z.custom<WorkspaceID>()),
  })),
)
