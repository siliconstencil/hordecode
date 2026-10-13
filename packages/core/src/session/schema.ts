import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@opencode-ai/core/id/id"
import { ZodOverride } from "@opencode-ai/core/util/effect-zod"
import { withStatics } from "@opencode-ai/core/util/schema"

export const SessionID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("session") }).pipe(
  Schema.brand("SessionID"),
  withStatics((s) => ({
    descending: (id?: string) => s.make(Identifier.descending("session", id)),
    zod: Identifier.schema("session").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("message") }).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
    zod: Identifier.schema("message").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("part") }).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
    zod: Identifier.schema("part").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>

// Backward-compat: fork core files use SessionSchema.ID, SessionSchema.Info,
// SessionV2.ID, SessionV2.Info from @opencode-ai/schema/session (V2 schema package).
// These preserve those references until those files are migrated to use SessionID directly.
import { Session } from "@opencode-ai/schema/session"

export const ID = Session.ID
export type ID = typeof ID.Type

export const Info = Session.Info
export type Info = Session.Info

export * as SessionSchema from "@opencode-ai/schema/session"
