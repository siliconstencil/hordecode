import path from "path"
import fs from "fs/promises"
import { randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"

// The security suites seed user-owned entries into the global config. Bun runs the
// tests in one process, so a file-level snapshot and restore drops another test's
// entries while its instance boots. Every global-config writer goes through this
// module: it serializes read-modify-write across test files and releases only the
// top-level keys it added. Module state is per test file, so the lease table lives
// on disk next to the config.

type Plain = Record<string, unknown>

type Lease = {
  base: { had: boolean; value?: unknown }
  entries: { id: string; value: unknown }[]
}

const configPath = () => path.join(Global.Path.config, "hordecode.json")
const stateDir = () => path.join(Global.Path.config, ".security-config-leases")
const lockDir = () => path.join(stateDir(), "lock")
const leaseFile = (key: string) => path.join(stateDir(), Buffer.from(key).toString("hex") + ".json")

const isPlain = (value: unknown): value is Plain =>
  value !== null && typeof value === "object" && !Array.isArray(value)

// A config file write is not atomic, so a read can see an empty or partial file while
// another test file writes it. Retry briefly instead of failing the load.
async function read(): Promise<Plain> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const text = await fs.readFile(configPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text === undefined) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (isPlain(parsed)) return parsed
    } catch {}
    await Bun.sleep(2)
  }
  throw new Error("shared global config is not valid JSON")
}

async function write(config: Plain) {
  if (Object.keys(config).length === 0) {
    await fs.rm(configPath(), { force: true }).catch(() => undefined)
    return
  }
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(configPath(), JSON.stringify(config))
}

async function lock<T>(body: () => Promise<T>): Promise<T> {
  await fs.mkdir(stateDir(), { recursive: true })
  const deadline = Date.now() + 15_000
  let release: (() => Promise<void>) | undefined
  while (!release) {
    try {
      await fs.mkdir(lockDir())
      release = () => fs.rm(lockDir(), { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const stat = await fs.stat(lockDir()).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > 15_000) {
        await fs.rm(lockDir(), { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the shared global config lock")
      await Bun.sleep(2)
    }
  }
  try {
    return await body()
  } finally {
    await release()
  }
}

async function readLease(key: string): Promise<Lease | undefined> {
  const text = await fs.readFile(leaseFile(key), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as Lease
  } catch {
    return undefined
  }
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch
  const out: Plain = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], value) : value
  }
  return out
}

// The last holder wins for a scalar, objects merge. A read-only entry such as
// `lsp: {}` keeps the built-in servers on while another file adds a custom server.
function effective(lease: Lease): { had: boolean; value?: unknown } {
  if (lease.entries.length === 0) return lease.base
  let value = lease.base.had ? lease.base.value : undefined
  for (const entry of lease.entries) value = merge(value, entry.value)
  return { had: true, value }
}

export async function holdGlobalConfig(patch: Plain): Promise<() => Promise<void>> {
  const id = randomUUID()
  const keys = Object.keys(patch)
  await lock(async () => {
    const config = await read()
    for (const key of keys) {
      const existing = key in config
      const lease = (await readLease(key)) ?? {
        base: existing ? { had: true, value: config[key] } : { had: false },
        entries: [],
      }
      lease.entries.push({ id, value: patch[key] })
      config[key] = effective(lease).value
      await Bun.write(leaseFile(key), JSON.stringify(lease))
    }
    await write(config)
  })
  let released = false
  return async () => {
    if (released) return
    released = true
    await lock(async () => {
      const config = await read()
      for (const key of keys) {
        const lease = await readLease(key)
        if (!lease) continue
        lease.entries = lease.entries.filter((entry) => entry.id !== id)
        const next = effective(lease)
        if (next.had) config[key] = next.value
        else delete config[key]
        if (lease.entries.length === 0) await fs.rm(leaseFile(key), { force: true }).catch(() => undefined)
        else await Bun.write(leaseFile(key), JSON.stringify(lease))
      }
      await write(config)
    })
  }
}
