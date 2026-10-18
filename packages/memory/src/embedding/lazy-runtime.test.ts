import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The exe-relative onnxruntime binding must not be dlopen'd at module load; it
// is loaded on first model start. Other native addons (msgpackr, onnxruntime-node)
// legitimately call process.dlopen, so the stub records only runtime-dir loads.
// Each case runs in a fresh process because module-level state is under test.
const serviceModule = path.resolve(import.meta.dir, "service.ts")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hordecode-lazy-runtime-"))
const fakeExe = path.join(root, "bin", "hordecode")
const binding = path.join(root, "bin", "runtime", "onnxruntime", "onnxruntime_binding.node")
fs.mkdirSync(path.dirname(binding), { recursive: true })
fs.writeFileSync(binding, "")

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function run(script: string) {
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env }, timeout: 60_000 })
  return { stdout: result.stdout.toString().trim(), code: result.exitCode }
}

const stub = `
  globalThis.__runtimeDlopen = []
  process.dlopen = (module, filename) => {
    if (filename.includes("/runtime/onnxruntime/")) globalThis.__runtimeDlopen.push(filename)
  }
`

describe("embedding service native binding", () => {
  test("importing the service module does not dlopen the runtime binding", () => {
    const result = run(`
      ${stub}
      Object.defineProperty(process, "execPath", { value: ${JSON.stringify(fakeExe)}, configurable: true })
      await import(${JSON.stringify(serviceModule)})
      console.log(JSON.stringify(globalThis.__runtimeDlopen))
    `)
    expect(result.code).toBe(0)
    expect(result.stdout.split("\n").pop()).toBe("[]")
  })

  test("first model start dlopens the exe-relative binding once, across layer instances", () => {
    const result = run(`
      ${stub}
      Object.defineProperty(process, "execPath", { value: ${JSON.stringify(fakeExe)}, configurable: true })
      const { Effect } = await import("effect")
      const { Service, layer } = await import(${JSON.stringify(serviceModule)})
      const start = Effect.gen(function* () {
        const svc = yield* Service
        yield* svc.available
        yield* Effect.sleep("50 millis")
      })
      await Effect.runPromise(start.pipe(Effect.provide(layer)))
      const afterFirst = globalThis.__runtimeDlopen.length
      await Effect.runPromise(start.pipe(Effect.provide(layer)))
      console.log(JSON.stringify({ afterFirst, total: globalThis.__runtimeDlopen.length, paths: globalThis.__runtimeDlopen }))
      process.exit(0)
    `)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.split("\n").pop()!)).toEqual({ afterFirst: 1, total: 1, paths: [binding] })
  })
})
