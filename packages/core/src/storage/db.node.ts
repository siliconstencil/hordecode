import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import fs from "node:fs"

export function init(path: string) {
  const sqlite = new DatabaseSync(path)
  const db = drizzle({ client: sqlite })
  if (path !== ":memory:") {
    try {
      fs.chmodSync(path, 0o600)
    } catch {}
  }
  return db
}
