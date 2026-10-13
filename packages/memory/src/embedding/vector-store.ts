import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Log } from "@opencode-ai/core/util"
import { MemoryFtsTable } from "../fts.sql"

const log = Log.create({ service: "memory.vectorstore" })

export interface Interface {
  readonly load: () => Effect.Effect<void>
  readonly search: (queryVec: Float32Array, topK: number) => Array<{ id: string; score: number }>
  readonly upsert: (id: string, vector: Float32Array) => void
  readonly invalidate: (id: string) => void
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryVectorStore") {}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function decodeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength)
}

export function createTestStore(initial?: Map<string, Float32Array>): Interface & { cache: Map<string, Float32Array> } {
  const cache = initial ? new Map(initial) : new Map<string, Float32Array>()
  return {
    cache,
    load: () => Effect.void,
    search: (queryVec: Float32Array, topK: number) => {
      const scored: Array<{ id: string; score: number }> = []
      for (const [id, vec] of cache.entries()) scored.push({ id, score: cosine(queryVec, vec) })
      return scored.sort((a, b) => b.score - a.score).slice(0, topK)
    },
    upsert: (id: string, vector: Float32Array) => {
      cache.set(id, vector)
    },
    invalidate: (id: string) => {
      cache.delete(id)
    },
  }
}

export const layer: Layer.Layer<Service, never, Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const cache = new Map<string, Float32Array>()

    const load = Effect.fn("MemoryVectorStore.load")(function* () {
      log.debug("load start")
      const rows = yield* database.db
        .select({ id: MemoryFtsTable.id, embedding: MemoryFtsTable.embedding })
        .from(MemoryFtsTable)
        .where(sql`${MemoryFtsTable.embedding} IS NOT NULL`)
        .all()
        .pipe(Effect.orDie)
      log.debug("load complete", { rows: rows.length })
      for (const row of rows) {
        if (!row.embedding) continue
        const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
        cache.set(String(row.id), vec)
      }
    })

    yield* load()

    const search = (queryVec: Float32Array, topK: number) => {
      const scored: Array<{ id: string; score: number }> = []
      for (const [id, vec] of cache.entries()) scored.push({ id, score: cosine(queryVec, vec) })
      return scored.sort((a, b) => b.score - a.score).slice(0, topK)
    }

    const upsert = (id: string, vector: Float32Array) => {
      cache.set(id, vector)
    }

    const invalidate = (id: string) => {
      cache.delete(id)
    }

    return Service.of({ load, search, upsert, invalidate })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
