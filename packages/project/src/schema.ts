import { Schema } from "effect"
import z from "zod"

import { withStatics } from "@opencode-ai/core/util/schema"

const projectIdSchema = Schema.String.pipe(Schema.brand("Project.ID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.make("global"),
    zod: z.string().pipe(z.custom<ProjectID>()),
  })),
)
