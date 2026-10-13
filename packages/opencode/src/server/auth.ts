export * as ServerAuth from "./auth"

import { createHash, timingSafeEqual } from "crypto"
import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("HORDECODE_SERVER_PASSWORD").pipe(
    EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_PASSWORD")),
    EffectConfig.option,
  ),
  username: EffectConfig.string("HORDECODE_SERVER_USERNAME").pipe(
    EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_USERNAME")),
    EffectConfig.withDefault("hordecode"),
  ),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Compare two strings in time proportional to the longer of the two, without
// leaking length. Hash both sides to a fixed length so timingSafeEqual can run
// on equal-length buffers (it throws on mismatch). length mismatch returns
// false without hashing either side, but the hash of an empty buffer keeps
// the operation cost roughly constant per call.
function timingSafeStringEqual(a: string, b: string) {
  const aHash = createHash("sha256").update(a).digest()
  const bHash = createHash("sha256").update(b).digest()
  return timingSafeEqual(aHash, bHash)
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (!Option.isSome(config.password)) return false
  const configPassword = config.password.value
  if (Redacted.value(credentials.password).length !== configPassword.length) return false
  return (
    timingSafeStringEqual(credentials.username, config.username) &&
    timingSafeStringEqual(Redacted.value(credentials.password), configPassword)
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.HORDECODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.HORDECODE_SERVER_USERNAME ?? "hordecode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
