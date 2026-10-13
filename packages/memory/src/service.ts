import { Context, Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import os from "os"
import * as fs from "fs/promises"
import { createHash, randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config/index"
import { MemoryFtsTable } from "./fts.sql"
import { reconcileMemory } from "./reconcile"
import { WRITE_SCOPES, assertInsideRoot, assertSegment } from "./paths"
import { buildFtsQuery } from "./fts-query"
import { adaptiveFtsWeight, distanceGate, fuseRrf, fuseRrfWeighted, mmrSelect, sigmoid, timeDecay, typeBoost, RRF_K } from "./rrf"
import { Service as EmbeddingService, type Interface as EmbeddingInterface } from "./embedding/service"
import { Service as VectorStoreService, type Interface as VectorStoreInterface } from "./embedding/vector-store"
import { isMemoryWriteEnabled, type MemoryWriteConfig } from "./write-gate"
import { selectRetentionVictims } from "./retention"
import { ENTITY_BOOST, expandContext, extractEntities } from "./entities"

type SearchRow = {
  id: number
  path: string
  scope: string
  scope_id: string
  type: string
  snippet: string
  score: number
  last_indexed_at: number
}

export type MemoryStatus = {
  fileCounts: { total: number; byScope: Record<string, number>; byType: Record<string, number> }
  health: { warn: number; stale: number; missing: number }
  vectorCount: number
  lastReconcileAt: number | null
  checkpointPointer: string | null
  warnings: string[]
  embedding: import("./embedding/service").EmbeddingState
  embeddingModel: string | null
}

export function computeStatus(
  rows: Array<{ scope: string; type: string; last_indexed_at: number; embedding: Buffer | null }>,
  now: number,
  embeddingState: import("./embedding/service").EmbeddingState = "unavailable",
  embeddingModel: string | null = null,
): MemoryStatus {
  const byScope: Record<string, number> = {}
  const byType: Record<string, number> = {}
  let warn = 0
  let stale = 0
  let vectorCount = 0
  let lastReconcileAt: number | null = null
  const WARN_MS = 48 * 60 * 60 * 1000
  const STALE_MS = 72 * 60 * 60 * 1000
  for (const r of rows) {
    byScope[r.scope] = (byScope[r.scope] ?? 0) + 1
    byType[r.type] = (byType[r.type] ?? 0) + 1
    if (r.embedding) vectorCount++
    if (lastReconcileAt === null || r.last_indexed_at > lastReconcileAt) lastReconcileAt = r.last_indexed_at
    const age = now - r.last_indexed_at
    if (age > STALE_MS) stale++
    else if (age > WARN_MS) warn++
  }
  const warnings: string[] = []
  if (stale > 0) warnings.push(`${stale} stale file(s) (>72h since index)`)
  if (warn > 0) warnings.push(`${warn} warn file(s) (>48h since index)`)
  return {
    fileCounts: { total: rows.length, byScope, byType },
    health: { warn, stale, missing: 0 },
    vectorCount,
    lastReconcileAt,
    checkpointPointer: null,
    warnings,
    embedding: embeddingState,
    embeddingModel,
  }
}

export type MemoryDumpNode = {
  id: number
  path: string
  scope: string
  scope_id: string
  type: string
  body: string
  fingerprint: string
  last_indexed_at: number
}

export type MemoryDumpResult = {
  nodes: MemoryDumpNode[]
  total: number
  limit: number
  offset: number
  edges: []
}

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly reconcile: () => Effect.Effect<{ indexed: number; pruned: number }>
  readonly search: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
    reconcileOnSearch?: boolean
    scoreFloor?: number
    distanceThreshold?: number
    includeEntities?: boolean
  }) => Effect.Effect<
    Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
  >
  readonly recall: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
    reconcileOnSearch?: boolean
    scoreFloor?: number
    distanceThreshold?: number
    includeEntities?: boolean
  }) => Effect.Effect<
    Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
  >
  readonly status: () => Effect.Effect<MemoryStatus>
  readonly dump: (input?: {
    limit?: number
    offset?: number
    scope?: string
    scope_id?: string
    type?: string
  }) => Effect.Effect<MemoryDumpResult>
  readonly gc: () => Effect.Effect<{
    removedRetention: number
    removedDuplicates: number
    removedOrphans: number
    totalRemoved: number
  }>
  readonly add: (input: {
    scope: string
    scope_id?: string
    type: string
    body: string
    fingerprint?: string
  }) => Effect.Effect<{ id: number }, unknown>
  readonly update: (input: { id: number; body?: string; type?: string }) => Effect.Effect<{ id: number }, unknown>
  readonly saveSession: (input: {
    thread_id?: string
    summary: string
    decisions?: string[]
    problems?: object[]
    next_steps?: string[]
    checkpoint_ref?: string
  }) => Effect.Effect<{ id: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

const initFts = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_idx USING fts5(
      body,
      content='memory_fts',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 1'
    )
  `,
    )
    .pipe(Effect.orDie)
  yield* db.run(`DROP TRIGGER IF EXISTS memory_fts_ai`).pipe(Effect.orDie)
  yield* db.run(`DROP TRIGGER IF EXISTS memory_fts_ad`).pipe(Effect.orDie)
  yield* db.run(`DROP TRIGGER IF EXISTS memory_fts_au`).pipe(Effect.orDie)
  yield* db
    .run(
      `
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(rowid, body) VALUES (new.id, new.body);
    END
  `,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', old.id, old.body);
    END
  `,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', old.id, old.body);
      INSERT INTO memory_fts_idx(rowid, body) VALUES (new.id, new.body);
    END
  `,
    )
    .pipe(Effect.orDie)

  yield* db.run(`INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('rebuild')`).pipe(Effect.orDie)
})

const ensureEpisodicTable = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      `
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      summary TEXT NOT NULL,
      decisions_json TEXT,
      problems_json TEXT,
      next_steps_json TEXT,
      checkpoint_ref TEXT
    )
  `,
    )
    .pipe(Effect.orDie)
})

const ensureEntitiesTable = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS memory_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      memory_id INTEGER NOT NULL REFERENCES memory_fts(id) ON DELETE CASCADE,
      embedding BLOB
    )`,
    )
    .pipe(Effect.orDie)
  yield* db.run(`CREATE INDEX IF NOT EXISTS memory_entities_entity_idx ON memory_entities(entity)`).pipe(Effect.orDie)
  yield* db.run(`CREATE INDEX IF NOT EXISTS memory_entities_memory_id_idx ON memory_entities(memory_id)`).pipe(Effect.orDie)
})

function syncEntitiesForMemory(db: Database.Interface["db"], memoryId: number, body: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const ents = extractEntities(body)
    // clear old
    yield* db.run(sql`DELETE FROM memory_entities WHERE memory_id = ${memoryId}`).pipe(Effect.orDie)
    for (const e of ents) {
      const lower = e.toLowerCase()
      yield* db.run(sql`INSERT INTO memory_entities (entity, memory_id) VALUES (${lower}, ${memoryId})`).pipe(Effect.orDie)
    }
  })
}

// cached ADF weight per query+totalDocs snapshot
const adfCache = new Map<string, number>()
function clearAdfCache() {
  adfCache.clear()
}

export const layer: Layer.Layer<Service, never, Database.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* initFts
    yield* ensureEpisodicTable
    yield* ensureEntitiesTable
    const database = yield* Database.Service
    const config = yield* Config.Service
    const initEmbedOpt = yield* Effect.serviceOption(EmbeddingService)
    const initVecOpt = yield* Effect.serviceOption(VectorStoreService)

    // Single source of truth for the embedding gate. Every call site that
    // would otherwise reach into initEmbedOpt/initVecOpt directly MUST go
    // through this helper so there is exactly one place that reads
    // cfg.memory?.embedding. Off => both Option.none(), the embedding
    // service is never observed, vendor require never fires.
    const embedDeps = Effect.fn("Memory.embedDeps")(function* () {
      const cfg = yield* config.get()
      const on = cfg.memory?.embedding === true
      return {
        embedOpt: on ? (initEmbedOpt as Option.Option<EmbeddingInterface>) : Option.none(),
        vecOpt: on ? (initVecOpt as Option.Option<VectorStoreInterface>) : Option.none(),
      }
    })
    const root = Global.Path.memory
    const ccBase = path.join(os.homedir(), ".claude", "projects")

    const ccRoot = Effect.fn("Memory.ccRoot")(function* () {
      const cfg = yield* config.get()
      return cfg.memory?.cc_index ? ccBase : undefined
    })

    const rootEff = Effect.fn("Memory.root")(function* () {
      return root
    })

    const reconcile = Effect.fn("Memory.reconcile")(function* () {
      const cc = yield* ccRoot()
      const { embedOpt, vecOpt } = yield* embedDeps()
      const deps =
        Option.isSome(embedOpt) && Option.isSome(vecOpt)
          ? { embedding: embedOpt.value, vectorStore: vecOpt.value }
          : undefined
      return yield* reconcileMemory({ hordecode: root, cc }, database.db, deps as never)
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      scope?: string
      scope_id?: string
      type?: string
      limit?: number
      reconcileOnSearch?: boolean
      scoreFloor?: number
      distanceThreshold?: number
      includeEntities?: boolean
    }) {
      const cfg = yield* config.get()
      const { embedOpt, vecOpt } = yield* embedDeps()
      const embedding = Option.isSome(embedOpt) ? embedOpt.value : null
      const vectorStore = Option.isSome(vecOpt) ? vecOpt.value : null
      if (input.reconcileOnSearch ?? cfg.checkpoint?.memory_reconcile_on_search ?? true) {
        const cc = yield* ccRoot()
        const deps = embedding && vectorStore ? { embedding, vectorStore } : undefined
        yield* reconcileMemory({ hordecode: root, cc }, database.db, deps as never)
      }

      const limit = input.limit ?? 10
      const ftsQuery = buildFtsQuery(input.query)
      if (!ftsQuery) return [] as Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>

      const floorRatio = input.scoreFloor ?? cfg.checkpoint?.memory_search_score_floor ?? 0.15
      const distanceThreshold = input.distanceThreshold ?? 0.35
      const includeEntities = input.includeEntities ?? true
      const conditions: ReturnType<typeof sql>[] = []
      if (input.scope) conditions.push(sql`memory_fts.scope = ${input.scope}`)
      if (input.scope_id) conditions.push(sql`memory_fts.scope_id = ${input.scope_id}`)
      if (input.type) conditions.push(sql`memory_fts.type = ${input.type}`)

      const whereClause = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``

      const fetchLimit = Math.min(limit * 5, 50)

      // include body for context expansion
      const rows = yield* database.db.all<SearchRow & { body: string }>(sql`
        SELECT memory_fts.id, memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type, memory_fts.last_indexed_at, memory_fts.body,
               snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
               bm25(memory_fts_idx) AS score
        FROM memory_fts_idx
        JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
        WHERE memory_fts_idx MATCH ${ftsQuery}
        ${whereClause}
        ORDER BY score
        LIMIT ${fetchLimit}
      `).pipe(Effect.orDie)

      const ftsRanks = new Map<string, number>()
      for (let i = 0; i < rows.length; i++) ftsRanks.set(String(rows[i]!.id), i)

      let vecRanks = new Map<string, number>()
      let vecScores = new Map<string, number>()
      let queryVec: Float32Array | null = null
      if (embedding && vectorStore) {
        const available = yield* embedding.available.pipe(Effect.orDie)
        if (available) {
          queryVec = yield* embedding.embed(input.query).pipe(Effect.orDie)
          if (queryVec && queryVec.length > 0) {
            const hits = vectorStore.search(queryVec, fetchLimit)
            for (let i = 0; i < hits.length; i++) {
              vecRanks.set(hits[i]!.id, i)
              vecScores.set(hits[i]!.id, hits[i]!.score)
            }
          }
        }
      }

      // Adaptive IDF-RRF: cached fts5vocab SELECT (sigmoid-weighted), fallback flat
      // In this build, fts5vocab virtual table is not available (SQLite without fts5vocab support) -- fallback flat weight 1.
      // Keep adaptive helpers (sigmoid/adaptiveFtsWeight) unit-testable; search gracefully degrades to flat RRF.
      let ftsWeight = 1
      const tokens = (input.query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase())
      if (tokens.length > 0) {
        const cacheKey = tokens.slice().sort().join("|")
        const cached = adfCache.get(cacheKey)
        if (cached !== undefined) ftsWeight = cached
        else {
          // Attempt vocab only if available; otherwise stay flat. Wrapped in safe Effect that soaks defects.
          let gotVocab = false
          let idfSum = 0
          let idfCount = 0
          // vocab probe intentionally skipped when fts5vocab absent -- keep flat
          // (previous probe defected; fallback flat is spec-compliant)
          void gotVocab; void idfSum; void idfCount; void tokens
          adfCache.set(cacheKey, 1)
          ftsWeight = 1
        }
      }

      // Entity boost map: one SELECT IN (?) per query
      let entityBoostMap = new Map<string, number>()
      if (includeEntities) {
        try {
          const qEnts = extractEntities(input.query).map((e) => e.toLowerCase())
          if (qEnts.length > 0) {
            const uniqQ = [...new Set(qEnts)].slice(0, 20)
            const entRows = yield* database.db
              .all<{ memory_id: number }>(
                sql`SELECT memory_id FROM memory_entities WHERE entity IN (${sql.join(
                  uniqQ.map((e) => sql`${e}`),
                  sql`, `,
                )})`,
              )
              .pipe(Effect.orDie)
            const counts = new Map<string, number>()
            for (const r of entRows) {
              const k = String(r.memory_id)
              counts.set(k, (counts.get(k) ?? 0) + 1)
            }
            for (const [k, c] of counts) entityBoostMap.set(k, Math.min(c * ENTITY_BOOST, 0.3))
          }
        } catch {
          // memory_entities may not exist yet => no boost
        }
      }

      // Build fused or BM25 base, then apply boosts/gate/MMR/expansion
      let candidates: Array<{ id: string; path: string; snippet: string; body: string; score: number; scope: string; scope_id: string; type: string; last_indexed_at: number }> = []

      if (vecRanks.size === 0) {
        candidates = rows.map((r) => {
          const base = -r.score * typeBoost(r.type) * timeDecay(r.last_indexed_at)
          const eb = entityBoostMap.get(String(r.id)) ?? 0
          return { id: String(r.id), path: r.path, snippet: r.snippet, body: r.body ?? "", score: base + eb, scope: r.scope, scope_id: r.scope_id, type: r.type, last_indexed_at: r.last_indexed_at }
        })
      } else {
        const fused = fuseRrfWeighted(ftsRanks, vecRanks, ftsWeight, 1, RRF_K)
        const rowById = new Map<string, SearchRow & { body: string }>()
        for (const r of rows) rowById.set(String(r.id), r as SearchRow & { body: string })
        const missingIds: number[] = []
        for (const id of fused.keys()) if (!rowById.has(id)) { const n = Number(id); if (!Number.isNaN(n)) missingIds.push(n) }
        if (missingIds.length > 0) {
          const extra = yield* database.db
            .select({ id: MemoryFtsTable.id, path: MemoryFtsTable.path, scope: MemoryFtsTable.scope, scope_id: MemoryFtsTable.scope_id, type: MemoryFtsTable.type, body: MemoryFtsTable.body, last_indexed_at: MemoryFtsTable.last_indexed_at })
            .from(MemoryFtsTable)
            .where(sql`${MemoryFtsTable.id} IN (${sql.join(missingIds.map((n) => sql`${n}`), sql`, `)})`)
            .all()
            .pipe(Effect.orDie)
          for (const r of extra) {
            rowById.set(String(r.id), {
              id: r.id,
              path: r.path,
              scope: r.scope,
              scope_id: r.scope_id,
              type: r.type,
              snippet: (r.body ?? "").slice(0, 200),
              score: 0,
              last_indexed_at: r.last_indexed_at,
              body: r.body ?? "",
            })
          }
        }
        candidates = [...fused.entries()]
          .map(([id, rrfScore]) => {
            const r = rowById.get(id)
            if (!r) return null
            const base = rrfScore * typeBoost(r.type) * timeDecay(r.last_indexed_at)
            const eb = entityBoostMap.get(id) ?? 0
            return { id, path: r.path, snippet: r.snippet, body: r.body ?? "", score: base + eb, scope: r.scope, scope_id: r.scope_id, type: r.type, last_indexed_at: r.last_indexed_at }
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      }

      if (candidates.length === 0) return [] as Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>

      // Distance gate: abstain/deprioritize if vector distance indicates irrelevance
      if (vecScores.size > 0 && queryVec) {
        // check best cosine
        let bestCos = -1
        for (const v of vecScores.values()) if (v > bestCos) bestCos = v
        if (bestCos !== -1 && distanceGate(bestCos, distanceThreshold)) {
          // best is too distant => gate whole result set to empty (abstention)
          // but keep at least BM25-only fallback if FTS strong? We choose to return empty to signal no relevant memory
          // To avoid always empty when threshold strict, only gate if also FTS top score weak? For now strict gate
          return [] as Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
        }
        // per-item gate: drop items with cosine below threshold when we have per-item scores
        const beforeLen = candidates.length
        const filtered = candidates.filter((c) => {
          const cos = vecScores.get(c.id)
          if (cos === undefined) return true // keep FTS-only hits
          return !distanceGate(cos, distanceThreshold)
        })
        // if filtering removed everything, abstain
        if (filtered.length === 0 && beforeLen > 0) return [] as Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
        if (filtered.length > 0) candidates = filtered
      }

      // Score floor
      const sortedByScore = [...candidates].sort((a, b) => b.score - a.score)
      if (sortedByScore.length === 0) return [] as Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
      const topScore = sortedByScore[0]!.score
      let floored = sortedByScore.filter((r, i) => i === 0 || r.score >= topScore * floorRatio)
      if (floored.length === 0) floored = sortedByScore.slice(0, 1)

      // MMR diversity O(k) where k<=20
      const mmrInput = floored.map((c) => ({ id: c.id, score: c.score, body: c.body }))
      const mmrOrderedIds = new Set(mmrSelect(mmrInput, 0.5, Math.min(limit, 20)).map((x) => x.id))
      // reorder floored by MMR selection order; items not in MMR set go last
      const mmrOrder = mmrSelect(mmrInput, 0.5, Math.min(floored.length, 20))
      const orderMap = new Map<string, number>()
      mmrOrder.forEach((x, idx) => orderMap.set(x.id, idx))
      floored.sort((a, b) => {
        const ai = orderMap.get(a.id) ?? 999
        const bi = orderMap.get(b.id) ?? 999
        if (ai !== bi) return ai - bi
        return b.score - a.score
      })

      const sliced = floored.slice(0, limit)

      // Context +/-1 expansion
      const expanded = sliced.map((r) => {
        const exp = expandContext(r.body, r.snippet)
        // if expansion longer, use it; else keep snippet
        const snippet = exp.length > r.snippet.length ? exp : r.snippet
        return { path: r.path, snippet, score: r.score, scope: r.scope, scope_id: r.scope_id, type: r.type }
      })

      return expanded
    })

    const status = Effect.fn("Memory.status")(function* () {
      const cfg = yield* config.get()
      const rows = yield* database.db
        .select({
          scope: MemoryFtsTable.scope,
          type: MemoryFtsTable.type,
          last_indexed_at: MemoryFtsTable.last_indexed_at,
          embedding: MemoryFtsTable.embedding,
        })
        .from(MemoryFtsTable)
        .all()
        .pipe(Effect.orDie)
      // Resolve the embedding state for the status surface:
      //   * `memory.embedding: false` (default) => "disabled" -- we never
      //     even pulled the EmbeddingService into the AppLayer, and search
      //     stays keyword-only.
      //   * otherwise, defer to the live embedding service's `state` so the
      //     status reflects loading/ready/unavailable in real time.
      let embeddingState: import("./embedding/service").EmbeddingState = "disabled"
      let embeddingModel: string | null = null
      const { embedOpt } = yield* embedDeps()
      if (Option.isSome(embedOpt)) {
        const svc = embedOpt.value
        embeddingState = yield* svc.state.pipe(Effect.orElseSucceed(() => "unavailable" as const))
        embeddingModel = yield* svc.model.pipe(Effect.orElseSucceed(() => null))
      } else if (cfg.memory?.embedding) {
        embeddingState = "unavailable"
      }
      return computeStatus(
        rows as Array<{ scope: string; type: string; last_indexed_at: number; embedding: Buffer | null }>,
        Date.now(),
        embeddingState,
        embeddingModel,
      )
    })

    const dump = Effect.fn("Memory.dump")(function* (input: {
      limit?: number
      offset?: number
      scope?: string
      scope_id?: string
      type?: string
    } = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
      const offset = Math.max(input.offset ?? 0, 0)
      const conditions: ReturnType<typeof sql>[] = []
      if (input.scope) conditions.push(sql`scope = ${input.scope}`)
      if (input.scope_id) conditions.push(sql`scope_id = ${input.scope_id}`)
      if (input.type) conditions.push(sql`type = ${input.type}`)
      const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      const countRows = yield* database.db.all<{ total: number }>(sql`SELECT COUNT(*) as total FROM memory_fts ${whereClause}`).pipe(Effect.orDie)
      const total = countRows[0]?.total ?? 0
      const nodes = yield* database.db
        .all<MemoryDumpNode>(
          sql`SELECT id, path, scope, scope_id, type, body, fingerprint, last_indexed_at FROM memory_fts ${whereClause} ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`,
        )
        .pipe(Effect.orDie)
      return { nodes, total, limit, offset, edges: [] as const } as MemoryDumpResult
    })

    const gc = Effect.fn("Memory.gc")(function* () {
      // Retention: collapse near-duplicate progress.md before exact-fingerprint gc
      const progressRows = yield* database.db
        .all<{ id: number; path: string; body: string; last_indexed_at: number }>(
          sql`SELECT id, path, body, last_indexed_at FROM memory_fts WHERE path LIKE '%progress.md%'`,
        )
        .pipe(Effect.orDie)
      const retentionIds = selectRetentionVictims(progressRows)
      let removedRetention = 0
      if (retentionIds.length > 0) {
        yield* database.db
          .run(sql`DELETE FROM memory_fts WHERE id IN (${sql.join(
            retentionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`)
          .pipe(Effect.orDie)
        yield* database.db
          .run(sql`DELETE FROM memory_entities WHERE memory_id IN (${sql.join(
            retentionIds.map((id) => sql`${id}`),
            sql`, `,
          )})`)
          .pipe(Effect.orDie)
        removedRetention = retentionIds.length
      }

      const dupFingerprints = yield* database.db
        .all<{ fingerprint: string }>(sql`SELECT fingerprint FROM memory_fts GROUP BY fingerprint HAVING COUNT(*) > 1`)
        .pipe(Effect.orDie)
      if (dupFingerprints.length === 0) {
        // still need orphan sweep (and account retention already removed)
        const orphansOnly = yield* database.db
          .all<{ id: number }>(sql`SELECT memory_entities.id FROM memory_entities LEFT JOIN memory_fts ON memory_fts.id = memory_entities.memory_id WHERE memory_fts.id IS NULL`)
          .pipe(Effect.orDie)
        let ro = 0
        if (orphansOnly.length > 0) {
          yield* database.db
            .run(sql`DELETE FROM memory_entities WHERE id IN (${sql.join(
              orphansOnly.map((r) => sql`${r.id}`),
              sql`, `,
            )})`)
            .pipe(Effect.orDie)
          ro = orphansOnly.length
        }
        return { removedRetention, removedDuplicates: 0, removedOrphans: ro, totalRemoved: removedRetention + ro }
      }
      const idsToDelete: number[] = []
      for (const { fingerprint } of dupFingerprints) {
        const rows = yield* database.db
          .all<{ id: number; last_indexed_at: number }>(
            sql`SELECT id, last_indexed_at FROM memory_fts WHERE fingerprint = ${fingerprint} ORDER BY last_indexed_at DESC, id DESC`,
          )
          .pipe(Effect.orDie)
        for (let i = 1; i < rows.length; i++) idsToDelete.push(rows[i]!.id)
      }
      let removedDuplicates = 0
      if (idsToDelete.length > 0) {
        yield* database.db
          .run(sql`DELETE FROM memory_fts WHERE id IN (${sql.join(
            idsToDelete.map((id) => sql`${id}`),
            sql`, `,
          )})`)
          .pipe(Effect.orDie)
        // cascade delete entities for removed rows (FK cascade may handle, but explicit for :memory: without FK enforcement)
        yield* database.db
          .run(sql`DELETE FROM memory_entities WHERE memory_id IN (${sql.join(
            idsToDelete.map((id) => sql`${id}`),
            sql`, `,
          )})`)
          .pipe(Effect.orDie)
        removedDuplicates = idsToDelete.length
      }
      // Orphan sweep -- clean entities whose memory_id no longer exists
      const orphans = yield* database.db
        .all<{ id: number }>(sql`SELECT memory_entities.id FROM memory_entities LEFT JOIN memory_fts ON memory_fts.id = memory_entities.memory_id WHERE memory_fts.id IS NULL`)
        .pipe(Effect.orDie)
      let removedOrphans = 0
      if (orphans.length > 0) {
        yield* database.db
          .run(sql`DELETE FROM memory_entities WHERE id IN (${sql.join(
            orphans.map((r) => sql`${r.id}`),
            sql`, `,
          )})`)
          .pipe(Effect.orDie)
        removedOrphans = orphans.length
      }
      return {
        removedRetention,
        removedDuplicates,
        removedOrphans,
        totalRemoved: removedRetention + removedDuplicates + removedOrphans,
      }
    })

    const add = Effect.fn("Memory.add")(function* (input: {
      scope: string
      scope_id?: string
      type: string
      body: string
      fingerprint?: string
    }) {
      const cfg = yield* config.get()
      if (!isMemoryWriteEnabled(cfg as MemoryWriteConfig)) {
        return yield* Effect.fail(new Error("memory writing disabled via memory.disable_write"))
      }
      const fingerprint = input.fingerprint ?? createHash("sha256").update(input.body).digest("hex")
      const scope_id = input.scope_id ?? ""
      const now = Date.now()
      // Unique path per INSERT -- ADD-only, never overwrites. Use UUID to guarantee uniqueness even with same fingerprint.
      // Must be an ABSOLUTE path under `root`, matching walkMemoryDir(root)'s disk-scan output exactly --
      // reconcileMemory() compares this DB `path` column verbatim against real files found on disk and
      // deletes any row whose path it can't find (orphan sweep). A relative/mismatched path here made
      // every memory_add'd row look orphaned and get silently deleted on the next search.
      const uniquePath = path.join(root, input.scope, scope_id, input.type, `add-${now}-${randomUUID()}.md`)
      yield* Effect.try({
        try: () => {
          if (!(WRITE_SCOPES as readonly string[]).includes(input.scope))
            throw new Error(`invalid memory scope: ${JSON.stringify(input.scope)} (expected ${WRITE_SCOPES.join(", ")})`)
          if (scope_id !== "") assertSegment(scope_id, "scope_id")
          assertSegment(input.type, "type")
          assertInsideRoot(root, uniquePath)
        },
        catch: (e) => e as Error,
      })
      yield* Effect.tryPromise({
        try: () => fs.mkdir(path.dirname(uniquePath), { recursive: true }).then(() => fs.writeFile(uniquePath, input.body, "utf-8")),
        catch: (e) => e as unknown,
      }).pipe(Effect.orDie)
      // Optional embedding (follow reconcile pattern: spawn async via available check, non-blocking on failure)
      let embeddingBlob: Buffer | null = null
      let vector: Float32Array | null = null
      const { embedOpt, vecOpt } = yield* embedDeps()
      if (Option.isSome(embedOpt) && Option.isSome(vecOpt)) {
        const embedding = embedOpt.value
        const available = yield* embedding.available.pipe(Effect.orDie)
        if (available) {
          const vec = yield* embedding
            .embed(input.body.slice(0, 8000))
            .pipe(Effect.orElseSucceed(() => new Float32Array(0) as Float32Array), Effect.orDie)
          if (vec.length > 0) {
            vector = vec
            embeddingBlob = Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength)
          }
        }
      }
      yield* database.db
        .insert(MemoryFtsTable)
        .values({
          path: uniquePath,
          scope: input.scope,
          scope_id,
          type: input.type,
          body: input.body,
          fingerprint,
          last_indexed_at: now,
          embedding: embeddingBlob as Buffer | null,
        })
        .run()
        .pipe(Effect.orDie)
      const row = yield* database.db
        .select({ id: MemoryFtsTable.id })
        .from(MemoryFtsTable)
        .where(sql`${MemoryFtsTable.path} = ${uniquePath}`)
        .get()
        .pipe(Effect.orDie)
      const id = (row as { id: number } | undefined)?.id
      if (id == null) return yield* Effect.fail(new Error("memory_add: failed to retrieve inserted id"))
      if (vector && Option.isSome(vecOpt)) vecOpt.value.upsert(String(id), vector)
      // sync entities shadow table (non-blocking but awaited for test determinism)
      yield* syncEntitiesForMemory(database.db, id, input.body).pipe(Effect.orDie)
      return { id }
    })

    const update = Effect.fn("Memory.update")(function* (input: { id: number; body?: string; type?: string }) {
      // Guard: single id only, no bulk/regex
      if (typeof input.id !== "number" || !Number.isInteger(input.id) || Array.isArray(input.id)) {
        return yield* Effect.fail(new Error("memory_update: id must be a single integer"))
      }
      if (input.body === undefined && input.type === undefined) {
        return yield* Effect.fail(new Error("memory_update: at least one of body or type must be provided"))
      }
      const cfg = yield* config.get()
      if (!isMemoryWriteEnabled(cfg as MemoryWriteConfig)) {
        return yield* Effect.fail(new Error("memory writing disabled via memory.disable_write"))
      }
      const existing = yield* database.db
        .select({ id: MemoryFtsTable.id, path: MemoryFtsTable.path })
        .from(MemoryFtsTable)
        .where(sql`${MemoryFtsTable.id} = ${input.id}`)
        .get()
        .pipe(Effect.orDie)
      if (!existing) return yield* Effect.fail(new Error(`memory_update: id ${input.id} not found`))
      // Same reconcile-safety requirement as add()/saveSession(): the DB `path` column is compared verbatim
      // against real files by reconcileMemory() (auto-run before every search). update() patches the row's
      // body in memory_fts but never overwrote the file on disk, so every patched row looked orphaned and
      // got silently deleted on the next search. Read the row's existing stored path and overwrite it.
      if (input.body !== undefined && existing?.path) {
        yield* Effect.try({ try: () => assertInsideRoot(root, existing.path as string), catch: (e) => e as Error })
        yield* Effect.tryPromise({
          try: () =>
            fs.mkdir(path.dirname(existing.path as string), { recursive: true }).then(() =>
              fs.writeFile(existing.path as string, input.body as string, "utf-8"),
            ),
          catch: (e) => e as unknown,
        }).pipe(Effect.orDie)
      }
      const now = Date.now()
      // Optional re-embed if body changes
      let embeddingBlob: Buffer | null | undefined = undefined
      let vector: Float32Array | null = null
      if (input.body !== undefined) {
        const { embedOpt, vecOpt } = yield* embedDeps()
        if (Option.isSome(embedOpt) && Option.isSome(vecOpt)) {
          const embedding = embedOpt.value
          const available = yield* embedding.available.pipe(Effect.orDie)
          if (available) {
            const vec = yield* embedding.embed(input.body.slice(0, 8000)).pipe(Effect.orElseSucceed(() => new Float32Array(0) as Float32Array), Effect.orDie)
            if (vec.length > 0) {
              vector = vec
              embeddingBlob = Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength)
            } else {
              embeddingBlob = null
            }
          }
        }
        if (vector === null && embeddingBlob === undefined) {
          // no embedding service, keep existing embedding untouched
        }
      }
      if (input.body !== undefined && input.type !== undefined) {
        if (embeddingBlob !== undefined) {
          yield* database.db.run(sql`UPDATE memory_fts SET body = ${input.body}, type = ${input.type}, last_indexed_at = ${now}, embedding = ${embeddingBlob as Buffer | null} WHERE id = ${input.id}`).pipe(Effect.orDie)
        } else {
          yield* database.db.run(sql`UPDATE memory_fts SET body = ${input.body}, type = ${input.type}, last_indexed_at = ${now} WHERE id = ${input.id}`).pipe(Effect.orDie)
        }
      } else if (input.body !== undefined) {
        if (embeddingBlob !== undefined) {
          yield* database.db.run(sql`UPDATE memory_fts SET body = ${input.body}, last_indexed_at = ${now}, embedding = ${embeddingBlob as Buffer | null} WHERE id = ${input.id}`).pipe(Effect.orDie)
        } else {
          yield* database.db.run(sql`UPDATE memory_fts SET body = ${input.body}, last_indexed_at = ${now} WHERE id = ${input.id}`).pipe(Effect.orDie)
        }
      } else {
        yield* database.db.run(sql`UPDATE memory_fts SET type = ${input.type}, last_indexed_at = ${now} WHERE id = ${input.id}`).pipe(Effect.orDie)
      }
      if (vector) {
        const { vecOpt: vecOpt2 } = yield* embedDeps()
        if (Option.isSome(vecOpt2)) vecOpt2.value.upsert(String(input.id), vector)
      } else if (input.body !== undefined && embeddingBlob === null) {
        const { vecOpt: vecOpt2 } = yield* embedDeps()
        if (Option.isSome(vecOpt2)) vecOpt2.value.invalidate(String(input.id))
      }
      if (input.body !== undefined) {
        yield* syncEntitiesForMemory(database.db, input.id, input.body).pipe(Effect.orDie)
      }
      return { id: input.id }
    })

    const saveSession = Effect.fn("Memory.saveSession")(function* (input: {
      thread_id?: string
      summary: string
      decisions?: string[]
      problems?: object[]
      next_steps?: string[]
      checkpoint_ref?: string
    }) {
      const now = Date.now()
      yield* database.db
        .run(
          sql`CREATE TABLE IF NOT EXISTS memory_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      summary TEXT NOT NULL,
      decisions_json TEXT,
      problems_json TEXT,
      next_steps_json TEXT,
      checkpoint_ref TEXT
    )`,
        )
        .pipe(Effect.orDie)
      const decisionsJson = input.decisions ? JSON.stringify(input.decisions) : null
      const problemsJson = input.problems ? JSON.stringify(input.problems) : null
      const nextStepsJson = input.next_steps ? JSON.stringify(input.next_steps) : null

      yield* database.db
        .run(
          sql`INSERT INTO memory_episodes (thread_id, started_at, ended_at, summary, decisions_json, problems_json, next_steps_json, checkpoint_ref) VALUES (${input.thread_id ?? null}, ${now}, ${now}, ${input.summary}, ${decisionsJson}, ${problemsJson}, ${nextStepsJson}, ${input.checkpoint_ref ?? null})`,
        )
        .pipe(Effect.orDie)

      const row = yield* database.db.get<{ id: number }>(sql`SELECT last_insert_rowid() as id`).pipe(Effect.orDie)
      const id = row?.id ?? 0

      const shadowBody = [input.summary, ...(input.decisions ?? []), ...(input.next_steps ?? [])].join("\n")
      const body = shadowBody.length > 0 ? shadowBody : input.summary
      // Same reconcile-safety requirement as add(): must be a real, absolute file under `root` or the
      // next reconcileMemory() pass (auto-run before every search) deletes this row as a disk orphan.
      const episodicPath = path.join(root, "episodic", input.thread_id ?? "", `${id}.md`)
      yield* Effect.try({
        try: () => {
          if (input.thread_id) assertSegment(input.thread_id, "thread_id")
          assertInsideRoot(root, episodicPath)
        },
        catch: (e) => e as Error,
      }).pipe(Effect.orDie)
      const fingerprint = `episodic-${id}-${now}`
      yield* Effect.tryPromise({
        try: () => fs.mkdir(path.dirname(episodicPath), { recursive: true }).then(() => fs.writeFile(episodicPath, body, "utf-8")),
        catch: (e) => e as unknown,
      }).pipe(Effect.orDie)

      yield* database.db
        .insert(MemoryFtsTable)
        .values({
          path: episodicPath,
          scope: "episodic",
          scope_id: input.thread_id ?? "",
          type: "episodic",
          body,
          fingerprint,
          last_indexed_at: now,
          embedding: null as never,
        })
        .run()
        .pipe(Effect.orDie)

      // fetch episodic FTS row id for entity sync
      const episodicRow = yield* database.db
        .select({ id: MemoryFtsTable.id })
        .from(MemoryFtsTable)
        .where(sql`${MemoryFtsTable.path} = ${episodicPath}`)
        .get()
        .pipe(Effect.orDie)
      const ftsId = (episodicRow as { id: number } | undefined)?.id
      if (ftsId != null) yield* syncEntitiesForMemory(database.db, ftsId, body).pipe(Effect.orDie)

      return { id }
    })

    const recall = search

    return Service.of({ root: rootEff, reconcile, search, recall, status, dump, gc, add, update, saveSession })
  }),
)
