import { Effect, Fiber, ScopedCache, Scope, Context } from "effect"
import * as EffectLogger from "./logger"
import { Instance, type InstanceContext } from "@opencode-ai/project/instance"
import { LocalContext } from "@opencode-ai/core/util"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@opencode-ai/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const bind = <F extends (...args: any[]) => any>(fn: F): F => {
  try {
    return Instance.bind(fn)
  } catch (err) {
    if (!(err instanceof LocalContext.NotFound)) throw err
  }
  const fiber = Fiber.getCurrent()
  const ctx = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
  if (!ctx) return fn
  return ((...args: any[]) => Instance.restore(ctx, () => fn(...args))) as F
}

export const context = Effect.gen(function* () {
  const ref = yield* InstanceRef
  if (ref) return ref
  const fromALS = (() => {
    try {
      return Instance.current
    } catch (e) {
      if (e instanceof LocalContext.NotFound) return undefined
      throw e
    }
  })()
  if (fromALS) return fromALS
  const cwd = process.cwd()
  return {
    directory: cwd,
    worktree: cwd,
    project: {
      id: "global" as any,
      worktree: cwd,
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    } as any,
  } as InstanceContext
})

export const workspaceID = Effect.gen(function* () {
  const ref = yield* WorkspaceRef
  if (ref !== undefined) return ref
  const fromALS = (() => {
    try {
      return WorkspaceContext.workspaceID
    } catch (e) {
      if (e instanceof LocalContext.NotFound) return undefined
      throw e
    }
  })()
  if (fromALS) return fromALS
  return "global" as any
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
  opts?: { phase?: "normal" | "late" },
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer(
      (directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory).pipe(Effect.provide(EffectLogger.layer))),
      { phase: opts?.phase },
    )
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })
