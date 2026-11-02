import * as fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { MemoryFtsTable } from "./fts.sql"
import { parsePath, parseCcPath, parseCcFrontmatterType, type MemoryLocator } from "./paths"
import { Database } from "@opencode-ai/core/database/database"
import type { Interface as EmbeddingInterface } from "./embedding/service"
import type { Interface as VectorStoreInterface } from "./embedding/vector-store"
import { extractEntities } from "./entities"

type DrizzleDb = Database.Interface["db"]

type ReconcileDeps = {
  embedding?: EmbeddingInterface
  vectorStore?: VectorStoreInterface
}

export function walkMemoryDir(root: string): Promise<string[]> {
  const out: string[] = []
  async function recurse(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as import("fs").Dirent[]
      throw e
    })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await recurse(full)
      else if (entry.isFile() && /\.md$/i.test(full)) out.push(full)
    }
  }
  return recurse(root).then(() => out)
}

export function walkCcRoot(base: string): Promise<string[]> {
  const out: string[] = []
  async function recurse() {
    const slugs = await fs.readdir(base, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as import("fs").Dirent[]
      throw e
    })
    for (const entry of slugs) {
      if (!entry.isDirectory()) continue
      const memoryDir = path.join(base, entry.name, "memory")
      const exists = await fs.stat(memoryDir).then(() => true).catch(() => false)
      if (!exists) continue
      const files = await walkMemoryDir(memoryDir)
      for (const f of files) out.push(f)
    }
  }
  return recurse().then(() => out)
}

export type Pending = {
  absPath: string
  loc: MemoryLocator
  bodyType: "hordecode" | "cc"
  body: string
  fingerprint: string
  finalType: string
}

export function alignVectors(pending: Pick<Pending, "absPath">[], vecs: Float32Array[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  for (let i = 0; i < pending.length && i < vecs.length; i++) {
    const v = vecs[i]
    if (v && v.length > 0) out.set(pending[i]!.absPath, v)
  }
  return out
}

// Rows indexed while no embedding provider was ready keep a NULL embedding; reconcile skips an
// unchanged file, so they are embedded here instead. Bounded per call so a search or index pass
// never waits on the whole backlog.
export const BACKFILL_BATCH = 16

export function backfillEmbeddings(db: DrizzleDb, deps: ReconcileDeps): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    if (!deps.embedding || !deps.vectorStore) return 0
    const available = yield* deps.embedding.available.pipe(Effect.orDie)
    if (!available) return 0
    const rows = yield* db
      .select({ id: MemoryFtsTable.id, body: MemoryFtsTable.body })
      .from(MemoryFtsTable)
      .where(sql`${MemoryFtsTable.embedding} IS NULL AND ${MemoryFtsTable.body} <> ''`)
      .orderBy(MemoryFtsTable.id)
      .limit(BACKFILL_BATCH)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return 0
    const vecs = (yield* deps.embedding
      .embedBatch(rows.map((r) => r.body.slice(0, 8000)))
      .pipe(Effect.orElseSucceed(() => [] as Float32Array[]), Effect.orDie)) as Float32Array[]
    let embedded = 0
    for (let i = 0; i < rows.length; i++) {
      const vec = vecs[i]
      if (!vec || vec.length === 0) continue
      const blob = Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength)
      yield* db
        .update(MemoryFtsTable)
        .set({ embedding: blob as Buffer | null })
        .where(eq(MemoryFtsTable.id, rows[i]!.id))
        .run()
        .pipe(Effect.orDie)
      deps.vectorStore.upsert(String(rows[i]!.id), vec)
      embedded++
    }
    return embedded
  })
}

export function reconcileMemory(
  roots: { hordecode: string; cc?: string },
  db: DrizzleDb,
  deps?: ReconcileDeps,
): Effect.Effect<{ indexed: number; pruned: number; backfilled: number }, never, never> {
  return Effect.gen(function* () {
    const hordecodeFiles = new Set<string>(
      yield* Effect.tryPromise({
        try: () => walkMemoryDir(roots.hordecode),
        catch: (e) => e,
      }).pipe(Effect.orDie),
    )
    const ccFiles = roots.cc
      ? new Set<string>(
          yield* Effect.tryPromise({
            try: () => walkCcRoot(roots.cc!),
            catch: (e) => e,
          }).pipe(Effect.orDie),
        )
      : new Set<string>()
    const diskPaths = new Set<string>([...hordecodeFiles, ...ccFiles])

    const rows = yield* db
      .select({ path: MemoryFtsTable.path, fingerprint: MemoryFtsTable.fingerprint })
      .from(MemoryFtsTable)
      .all()
      .pipe(Effect.orDie)

    const indexed = new Map<string, string>(rows.map((r) => [r.path, r.fingerprint]))

    let pruned = 0
    for (const p of indexed.keys()) {
      if (!diskPaths.has(p)) {
        // The vector cache is keyed by row id, not by path (see reconcileMemory's upsert below).
        const gone = yield* db.select({ id: MemoryFtsTable.id }).from(MemoryFtsTable).where(eq(MemoryFtsTable.path, p)).get().pipe(Effect.orDie)
        yield* db.delete(MemoryFtsTable).where(eq(MemoryFtsTable.path, p)).run().pipe(Effect.orDie)
        if (gone) deps?.vectorStore?.invalidate(String(gone.id))
        pruned++
      }
    }

    const pending: Pending[] = []

    const collect = (files: Set<string>, bodyType: "hordecode" | "cc", parser: (p: string) => MemoryLocator | null) =>
      Effect.gen(function* () {
        for (const p of files) {
          const loc = parser(p)
          if (!loc) {
            console.warn("path outside memory layout, skipping", { path: p })
            continue
          }
          const stat = yield* Effect.tryPromise({
            try: () => fs.stat(p),
            catch: (e) => e as NodeJS.ErrnoException,
          }).pipe(
            Effect.catchIf(
              (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
              () => Effect.succeed(null),
            ),
            Effect.orDie,
          )
          if (!stat) continue
          const fingerprint = `${stat.size}-${stat.mtimeMs}`
          if (indexed.get(p) === fingerprint) continue
          const body = yield* Effect.tryPromise(() => Bun.file(p).text()).pipe(Effect.orDie)
          const finalType = bodyType === "cc" ? (parseCcFrontmatterType(body) ?? "free") : loc.type
          pending.push({ absPath: p, loc, bodyType, body, fingerprint, finalType })
        }
      })

    yield* collect(hordecodeFiles, "hordecode", parsePath)
    yield* collect(ccFiles, "cc", parseCcPath)

    const backfilled = deps ? yield* backfillEmbeddings(db, deps) : 0

    if (pending.length === 0) return { indexed: 0, pruned, backfilled }

    let vectors: Map<string, Float32Array> = new Map()
    if (deps?.embedding) {
      const available = yield* deps.embedding.available.pipe(Effect.orDie)
      if (available) {
        const texts = pending.map((p) => p.body.slice(0, 8000))
        const vecs = (yield* deps.embedding.embedBatch(texts).pipe(Effect.orElseSucceed(() => [] as Float32Array[]), Effect.orDie)) as Float32Array[]
        vectors = alignVectors(pending, vecs)
      }
    }

    let indexedCount = 0
    for (const p of pending) {
      const vec = vectors.get(p.absPath)
      const blob = vec ? Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength) : null
      yield* db
        .insert(MemoryFtsTable)
        .values({
          path: p.absPath,
          scope: p.loc.scope,
          scope_id: p.loc.scope_id,
          type: p.finalType,
          body: p.body,
          fingerprint: p.fingerprint,
          last_indexed_at: Date.now(),
          embedding: blob as Buffer | null,
        })
        .onConflictDoUpdate({
          target: MemoryFtsTable.path,
          set: {
            // `type` deliberately excluded from the conflict-update set. Rows written directly by
            // memory.add()/saveSession() store a content-hash fingerprint (sha256(body)), which never
            // equals this function's disk-derived `${size}-${mtimeMs}` fingerprint format -- so on the
            // very first reconcile pass after such a write, this branch always fires once even though
            // nothing changed. detectType(key) only recognizes a small fixed set of filename patterns
            // (memory/checkpoint/progress/notes) and falls back to "free" for everything else, which
            // silently clobbered the caller's real `type` (e.g. "concept", "decision") on that first
            // pass. Re-detecting type only for genuinely NEW rows (the `values()` above) is correct;
            // an existing row's type should not flip out from under a caller who explicitly set it.
            scope: p.loc.scope,
            scope_id: p.loc.scope_id,
            body: p.body,
            fingerprint: p.fingerprint,
            last_indexed_at: Date.now(),
            embedding: blob as Buffer | null,
          },
        })
        .run()
        .pipe(Effect.orDie)
      if (deps?.vectorStore) {
        // A re-indexed row whose new embedding is NULL must not keep the previous body's vector in the cache.
        const row = yield* db
          .select({ id: MemoryFtsTable.id })
          .from(MemoryFtsTable)
          .where(eq(MemoryFtsTable.path, p.absPath))
          .get()
          .pipe(Effect.orDie)
        if (row && vec) deps.vectorStore.upsert(String(row.id), vec)
        if (row && !vec) deps.vectorStore.invalidate(String(row.id))
      }
      // sync entities shadow table for this memory_id (non-blocking but awaited)
      try {
        const row2 = yield* db
          .select({ id: MemoryFtsTable.id })
          .from(MemoryFtsTable)
          .where(eq(MemoryFtsTable.path, p.absPath))
          .get()
          .pipe(Effect.orDie)
        if (row2) {
          const ents = extractEntities(p.body)
          yield* db.run(sql`DELETE FROM memory_entities WHERE memory_id = ${row2.id}`).pipe(Effect.orDie)
          for (const e of ents) {
            const lower = e.toLowerCase()
            yield* db.run(sql`INSERT INTO memory_entities (entity, memory_id) VALUES (${lower}, ${row2.id})`).pipe(Effect.orDie)
          }
        }
      } catch {
        // entities table may not exist yet
      }
      indexedCount++
    }

    return { indexed: indexedCount, pruned, backfilled }
  })
}
