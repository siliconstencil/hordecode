export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { Path as StorageDbPath } from "../storage/db"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* assertSupportedRuntimeSchema(db)
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

// sqliteLayer is self-contained (bundles nativeLayer + Reactivity), so the
// provided layer is fully satisfied; pin the R to never so consumers
// (Layer.build, Effect.provide chains) don't inherit an unprovable requirement.
export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename }))) as Layer.Layer<Service, never, never>
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  // Must resolve to the same file as the storage path (storage/db.ts) --
  // the two worlds share one database. storage/db.ts honors HORDECODE_DB and
  // HORDECODE_DISABLE_CHANNEL_DB (default true => plain hordecode.db).
  return StorageDbPath
}

export function assertSupportedRuntimeSchema(db: any) {
  return Effect.gen(function* () {
    const uv = yield* Effect.orElseSucceed(db.get("PRAGMA user_version"), () => ({ user_version: 0 }) as any)
    const hasTable = yield* Effect.orElseSucceed(
      db.get("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='runtime_schema_version'"),
      () => ({ n: 0 }) as any,
    )
    const rv = hasTable?.n > 0
      ? yield* Effect.orElseSucceed(db.get('SELECT minimum_version FROM "runtime_schema_version" WHERE id=1'), () => null as any)
      : null
    const effective = Math.max((uv as any)?.user_version ?? 0, (rv as any)?.minimum_version ?? 0)
    if (effective > 3) return yield* Effect.die("upgrade-required: downgrade_guard - database minimum_runtime_schema_version=3 requires newer binary")
  })
}

// layerFromPath is fully self-contained (sqliteLayer bundles nativeLayer +
// Reactivity), so the node has no dependencies. The suspended layer's R must
// be pinned to never: DatabaseMigration's Migration type annotates its effects
// Effect<void, unknown, unknown>, which would otherwise leak an unprovable
// unknown requirement into CheckDependencies.
export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())) as Layer.Layer<Service, never, never>, deps: [] })
