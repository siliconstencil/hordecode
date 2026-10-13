export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("HORDECODE_SERVER_PASSWORD").pipe(
              EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_PASSWORD")),
              EffectConfig.option,
            ),
            username: EffectConfig.string("HORDECODE_SERVER_USERNAME").pipe(
              EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_USERNAME")),
              EffectConfig.withDefault("hordecode"),
            ),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.HORDECODE_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? Flag.HORDECODE_SERVER_USERNAME ?? "hordecode"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

// Flag-sourced variant, kept alongside the Config-based header()/headers()
// rather than replacing it -- middleware/authorization.ts and routes.ts
// depend on Config/required/authorized/header/headers. Overwriting verbatim
// silently broke both files; restored the Config-based implementation and
// kept this function as an addition instead of a replacement.
export function serverAuthHeader(credentials?: { password?: string; username?: string }): string | undefined {
  const password = credentials?.password ?? Flag.HORDECODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = credentials?.username ?? Flag.HORDECODE_SERVER_USERNAME ?? "hordecode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function serverAuthHeaders(credentials?: { password?: string; username?: string }):
  | { Authorization: string }
  | undefined {
  const header = serverAuthHeader(credentials)
  if (!header) return undefined
  return { Authorization: header }
}
