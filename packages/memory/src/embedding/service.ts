import path from "node:path"
import fs from "node:fs"
import { Context, Duration, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Log } from "@opencode-ai/core/util"
import { vendorRequire } from "../util/vendor-require"

const log = Log.create({ service: "memory.embedding" })

// Type for internal Node.js process.dlopen API (not in public types)
interface ProcessWithDlopen extends NodeJS.Process {
  dlopen(exports: NodeJS.Module, filename: string): void;
}

// Pre-load onnxruntime native binding from runtime dir (exe-relative).
// Build vendoring places the binding at <exe-dir>/runtime/onnxruntime/onnxruntime_binding.node
// Missing dir is graceful degrade (BM25-only).
const _RT_DIR = (() => {
  try {
    const exeDir = process.execPath ? path.dirname(process.execPath) : ""
    if (!exeDir) return ""
    const rt = path.resolve(exeDir, "runtime", "onnxruntime")
    const bind = path.join(rt, "onnxruntime_binding.node")
    if (fs.existsSync(bind)) {
      ;(process as ProcessWithDlopen).dlopen({ exports: {} } as NodeJS.Module, bind)
      return rt
    }
    return ""
  } catch {
    return ""
  }
})()
void _RT_DIR

export type EmbeddingState = "disabled" | "idle" | "loading" | "ready" | "unavailable"

export interface Interface {
  readonly available: Effect.Effect<boolean>
  readonly state: Effect.Effect<EmbeddingState>
  readonly model: Effect.Effect<string | null>
  readonly embed: (text: string) => Effect.Effect<Float32Array>
  readonly embedBatch: (texts: string[]) => Effect.Effect<Float32Array[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryEmbedding") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    let pipelineFn: ((text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>) | null = null
    let state: EmbeddingState = "idle"
    let initStarted = false
    let initAttempted = false
    let loggedFailure = false
    let modelName: string | null = null

    const tryInit = Effect.gen(function* () {
      if (initAttempted) return
      initAttempted = true
      state = "loading"
      log.debug("tryInit start")
      // ORT_WASM_DIR stays exe-relative (shipped runtime artifact).
      process.env.ORT_WASM_DIR ??= path.join(path.dirname(process.execPath), "vendor")
      // HF_HOME is intentionally NOT set: the @huggingface/transformers node
      // build ignores HF_HOME and caches beside the binary under
      // vendor/node_modules/.../transformers/.cache. We route the model
      // downloads (which DO honour env.cacheDir on the transformers module)
      // to Global.Path.models = <cache>/models below.
      const mod = vendorRequire() as {
        env?: { cacheDir?: string }
        pipeline?: (task: string, model: string) => Promise<unknown>
      } | null
      log.debug("vendorRequire", { pipeline: !!mod?.pipeline })
      if (!mod?.pipeline) {
        if (!loggedFailure) {
          log.warn("vendor transformers module missing pipeline; memory stays BM25-only")
          loggedFailure = true
        }
        state = "unavailable"
        return
      }
      // After vendorRequire returns the module, point its cache at our
      // persistent model dir and ensure the dir exists. This is where the
      // ~133 MB model lands on first use -- not beside the binary.
      const modelDir = Global.Path.models
      yield* Effect.tryPromise({
        try: async () => {
          await fs.promises.mkdir(modelDir, { recursive: true })
        },
        catch: () => null,
      }).pipe(Effect.orDie)
      if (mod.env) mod.env.cacheDir = modelDir
      const pipeline = mod.pipeline
      const models = ["Xenova/bge-small-en-v1.5", "Xenova/all-MiniLM-L6-v2"]
      // Overall safety cap (10 minutes) so a hung download cannot keep
      // state="loading" forever. Init is already on a background fiber
      // (embedding issue), so search is never blocked; this cap only flips state to
      // "unavailable" if no candidate has resolved by then. The cap is a
      // Promise.race ONLY against the overall loop -- never against an
      // individual candidate, which would let a slow download be
      // abandoned and silently swapped for the fallback (model loading issue: two model
      // dirs on disk, active embedding space chosen by network speed).
      const overallCapMs = 10 * 60 * 1000
      const startedAt = Date.now()
      const overallTimedOut = () => Date.now() - startedAt >= overallCapMs
      const tryLoadOne = (
        model: string,
      ): Effect.Effect<
        ((text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>) | "fallback" | null
      > =>
        Effect.gen(function* () {
          // Awaits the pipeline promise itself; no per-candidate timer.
          // If it resolves we have the loader; if it rejects we surface
          // the rejection so the loop can fall back to the next model
          // (real error path), or surface the safety cap if we hit it.
          const loader = (yield* Effect.promise(() =>
            pipeline("feature-extraction", model),
          )) as typeof pipelineFn
          if (overallTimedOut()) {
            log.warn("embedding model cap exceeded after a successful load; discarding in-flight result", {
              model,
              elapsedMs: Date.now() - startedAt,
            })
            return null
          }
          return loader
        }).pipe(
          // Reject (e.g. fetch failure on this specific model) -> "fallback".
          // Anything else (defect, interruption) propagates so we know about it.
          Effect.catch((e) => {
            log.warn("embedding model failed, falling back to next candidate", { model, error: String(e) })
            return Effect.succeed("fallback" as const)
          }),
        )
      let loaded = false
      let lastError: unknown = null
      for (const model of models) {
        if (overallTimedOut()) break
        // Race the per-candidate load against the overall cap. The cap
        // is the only thing that can abandon a candidate mid-flight;
        // a slow download gets the full time it needs.
        const result = yield* Effect.race(
          tryLoadOne(model),
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(Math.max(0, overallCapMs - (Date.now() - startedAt))))
            log.warn("embedding model load cap exceeded", {
              elapsedMs: Date.now() - startedAt,
            })
            return null
          }),
        )
        if (result === "fallback") {
          lastError = new Error(`candidate ${model} rejected`)
          continue
        }
        if (result === null) {
          // cap fired -- treat as unavailable below
          break
        }
        if (typeof result === "function") {
          pipelineFn = result as typeof pipelineFn
          modelName = model
          loaded = true
          break
        }
      }
      if (loaded) {
        state = "ready"
      } else {
        if (!loggedFailure) {
          log.warn(
            overallTimedOut()
              ? `embedding model load cap (${overallCapMs}ms) exceeded without any candidate resolving; memory stays BM25-only`
              : `embedding model failed to load (both candidates rejected); memory stays BM25-only`,
            lastError ? { lastError: String(lastError) } : {},
          )
          loggedFailure = true
        }
        state = "unavailable"
      }
    })

    // Non-blocking kick: starts tryInit on a background fiber so the FIRST
    // available() call returns immediately with the current state (idle or
    // whatever tryInit has progressed to). embed() also kicks once but
    // returns an empty Float32Array until state == "ready" (BM25-only path
    // already works on top of FTS, so search degrades gracefully).
    const kickoff = () => {
      if (initStarted || initAttempted) return
      initStarted = true
      // Effect.runFork is the v4 process-global runner (see
      // packages/opencode/src/effect/bridge.ts:67). It starts the effect on
      // a fiber we don't need to await. Effect.ignore silences any
      // unexpected failure -- tryInit already logged a single warn above
      // if anything went wrong, so swallowing here is intentional.
      Effect.runFork(tryInit.pipe(Effect.ignore))
    }

    const available = Effect.gen(function* () {
      kickoff()
      const avail = pipelineFn !== null
      log.debug("available", { available: avail, state })
      return avail
    })

    const state$ = Effect.gen(function* () {
      return state
    })

    const model$ = Effect.gen(function* () {
      return modelName
    })

    const embed = (text: string) =>
      Effect.gen(function* () {
        log.debug("embed called", { len: text.length, state, model: modelName })
        kickoff()
        if (!pipelineFn || state !== "ready" || !text) return new Float32Array(0)
        const result = yield* Effect.tryPromise({
          try: () => pipelineFn!(text, { pooling: "mean", normalize: true }).catch(() => null),
          catch: () => null,
        }).pipe(Effect.orDie)
        if (!result) return new Float32Array(0)
        const data = (result as { data?: Float32Array | number[] }).data
        if (!data) return new Float32Array(0)
        const arr = Array.isArray(data) ? data : Array.from(data as Float32Array)
        return new Float32Array(arr.slice(0, 384))
      })

    const embedBatch = (texts: string[]) =>
      Effect.gen(function* () {
        if (texts.length === 0) return [] as Float32Array[]
        return yield* Effect.all(
          texts.map((t) => embed(t)),
          { concurrency: "unbounded" },
        )
      })

    return Service.of({ available, state: state$, model: model$, embed, embedBatch })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
