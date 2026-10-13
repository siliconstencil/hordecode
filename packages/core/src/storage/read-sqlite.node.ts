import { DatabaseSync } from "node:sqlite"
import type { ReadonlyDb } from "./read-sqlite"

// Parameters cast to `never[]`: node:sqlite versions differ in the exported type names
// for bound values (SupportedValueType / SQLInputValue etc). never can be assigned to any
// tuple parameter, avoiding dependence on the specific exported name.
export function openReadonly(path: string): ReadonlyDb {
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as unknown[],
    get: (sql, ...params) => (db.prepare(sql).get(...(params as never[])) ?? null) as unknown,
    close: () => db.close(),
  }
}
