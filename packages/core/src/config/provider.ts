export * as ConfigProvider from "./provider"

import { Schema } from "effect"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.Finite.pipe(Schema.optional),
  cache_write: Schema.Finite.pipe(Schema.optional),
  context_over_200k: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cache_read: Schema.Finite.pipe(Schema.optional),
    cache_write: Schema.Finite.pipe(Schema.optional),
  }).pipe(Schema.optional),
}) {}

class Limit extends Schema.Class<Limit>("ConfigV2.Model.Limit")({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
}) {}

const ModelApi = Schema.Union([
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.AISDK.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.Native.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID,
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  id: ModelV2.ID.pipe(Schema.optional),
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any)).pipe(Schema.optional),
  cost: Cost.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
  // Extended model fields
  release_date: Schema.String.pipe(Schema.optional),
  attachment: Schema.Boolean.pipe(Schema.optional),
  reasoning: Schema.Boolean.pipe(Schema.optional),
  temperature: Schema.Boolean.pipe(Schema.optional),
  tool_call: Schema.Boolean.pipe(Schema.optional),
  interleaved: Schema.Union([
    Schema.Literal(true),
    Schema.Struct({
      field: Schema.Literals(["reasoning_content", "reasoning_details"]),
    }),
  ]).pipe(Schema.optional),
  modalities: Schema.Struct({
    input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
  }).pipe(Schema.optional),
  experimental: Schema.Boolean.pipe(Schema.optional),
  status: Schema.Literals(["alpha", "beta", "deprecated"]).pipe(Schema.optional),
  cachePromptTTL: Schema.Literals(["5m", "1h"]).pipe(Schema.optional),
  provider: Schema.Struct({
    npm: Schema.String.pipe(Schema.optional),
    api: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  options: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  api: ProviderV2.Api.pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
  // Extended provider fields
  id: Schema.String.pipe(Schema.optional),
  npm: Schema.String.pipe(Schema.optional),
  whitelist: Schema.Array(Schema.String).pipe(Schema.optional),
  blacklist: Schema.Array(Schema.String).pipe(Schema.optional),
  options: Schema.Record(Schema.String, Schema.Any).pipe(Schema.optional),
  only_configured_models: Schema.Boolean.pipe(Schema.optional),
}) {}
