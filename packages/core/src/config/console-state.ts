import { Schema } from "effect"
import { zod } from "@opencode-ai/core/util/effect-zod"

export class ConsoleState extends Schema.Class<ConsoleState>("ConsoleState")({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optional(Schema.String),
  switchableOrgCount: Schema.Number,
}) {
  static readonly zod = zod(this)
}

export const emptyConsoleState: ConsoleState = ConsoleState.make({
  consoleManagedProviders: [],
  activeOrgName: undefined,
  switchableOrgCount: 0,
})
