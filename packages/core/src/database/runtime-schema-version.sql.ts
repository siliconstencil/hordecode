import { integer, sqliteTable } from "drizzle-orm/sqlite-core"

export const RuntimeSchemaVersionTable = sqliteTable("runtime_schema_version", {
  id: integer().primaryKey({ autoIncrement: false }),
  minimum_version: integer().notNull(),
})
