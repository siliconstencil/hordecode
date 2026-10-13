import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

const WINDOW_MS = 60_000
const MAX_REQUESTS = 20
const SWEEP_INTERVAL = 60_000

const windows = new Map<string, { count: number; resetAt: number }>()
let lastSweep = Date.now()

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL) return
  lastSweep = now
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key)
  }
}

export function checkLimit(
  key: string,
  now: number,
  windowMs: number,
  max: number,
): { allowed: boolean; retryAfterSeconds: number } {
  sweep(now)
  let entry = windows.get(key)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs }
    windows.set(key, entry)
  }
  entry.count++
  if (entry.count > max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

export class RateLimitMiddleware extends HttpApiMiddleware.Service<RateLimitMiddleware>()(
  "@opencode/HttpApiRateLimit",
) {}

export const rateLimitLayer = Layer.effect(RateLimitMiddleware, Effect.gen(function* () {
  return RateLimitMiddleware.of((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(request.url, "http://localhost").pathname
      const keyPrefix = pathname.endsWith("/prompt_async")
        ? "prompt_async"
        : pathname.endsWith("/shell")
          ? "shell"
          : undefined
      if (keyPrefix === undefined) return yield* effect
      const ip = request.headers["x-forwarded-for"] ?? "local"
      const { allowed, retryAfterSeconds } = checkLimit(
        `${keyPrefix}:${ip}`,
        Date.now(),
        WINDOW_MS,
        MAX_REQUESTS,
      )
      if (allowed) return yield* effect
      return HttpServerResponse.jsonUnsafe({ error: "Too many requests" }, {
        status: 429,
        headers: { "retry-after": String(retryAfterSeconds) },
      })
    }),
  )
}))
