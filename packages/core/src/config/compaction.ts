export * as ConfigCompaction from "./compaction"

import { Effect, Schema } from "effect"
import { NonNegativeInt } from "../schema"

const TokenQuantity = Schema.Union([NonNegativeInt, Schema.String])
const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(true))),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  tail_turns: Schema.Number.pipe(Schema.optional),
  preserve_recent_tokens: NonNegativeInt.pipe(Schema.optional),
  reserved: NonNegativeInt.pipe(Schema.optional),
  max_context: Schema.Union([TokenQuantity, Schema.Record(Schema.String, TokenQuantity)]).pipe(
    Schema.optional,
  ).annotate({
    description:
      'Compact earlier than the model window. A token count (300000), a shorthand string ("300K", "1M", "50%"), ' +
      'or a map keyed by "<providerID>/<modelID>" with wildcards ("openai/gpt-5*"). Always clamped to the ' +
      "model's real window — it can only lower the compaction trigger, never raise it. 0 means no budget.",
  }),
}) {}
