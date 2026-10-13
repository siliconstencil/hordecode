// Storage module barrel. Present upstream at v1.14.20 (upstream's fork
// point), byte-unchanged, then removed entirely by upstream before v1.17.18.
// Structurally required by storage/storage.ts and 38 other delta files that
// import from it (relative "../storage" in the source). Ported to avoid
// leaving each future consumer to rediscover the same missing barrel.
//
// JsonMigration re-export will land when storage/json-migration.ts is ported
// (real delta). storage/db.ts is already ported, completing the atomic group:
// effect/instance-state.ts, project/instance.ts, project/project.ts, and
// storage/db.ts. Database re-export added below as a namespace re-export since
// project.ts calls Database.use(), Database.Client etc.
export * as Storage from "./storage"
export * as Database from "./db"
export {
  asc,
  eq,
  and,
  or,
  inArray,
  desc,
  not,
  sql,
  isNull,
  isNotNull,
  count,
  like,
  exists,
  between,
  gt,
  gte,
  lt,
  lte,
  ne,
} from "drizzle-orm"
export type { SQL } from "drizzle-orm"
export { NotFoundError } from "./storage"
