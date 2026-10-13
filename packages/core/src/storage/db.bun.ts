import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import fs from "node:fs"

export function init(path: string) {
  const sqlite = new Database(path, { create: true })
  const db = drizzle({ client: sqlite })
  // Tighten DB file permissions to owner-only (0600). Best-effort: ignore if
  // path is :memory: or chmod is unavailable (e.g. on some CI filesystems).
  if (path !== ":memory:") {
    try {
      fs.chmodSync(path, 0o600)
    } catch {}
  }
  return db
}
