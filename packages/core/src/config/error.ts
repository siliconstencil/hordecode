export * as ConfigError from "./error"

import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"

export const JsonError = NamedError.create("ConfigJsonError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
})

export const InvalidError = NamedError.create("ConfigInvalidError", {
  path: Schema.String,
  issues: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})
