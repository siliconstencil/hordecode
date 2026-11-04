import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import type { TaskContract } from "@opencode-ai/task"

/**
 * Tool calls and USD of a session and every descendant session (parent_id chain: task, supervisor,
 * workflow and peer children), counted from `since`, read straight from the message and part tables so
 * compaction, which only hides rows from the model's view, does not lower it. Tool parts are counted by
 * part creation time, cost by assistant message creation time.
 */
export const read = (db: Database.Interface["db"], root: string, since: number) =>
  db
    .all<{ calls: number; cost: number }>(
      sql`WITH RECURSIVE tree(id) AS (
            SELECT ${root} UNION ALL SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id
          )
          SELECT
            (SELECT count(*) FROM part p
              WHERE p.session_id IN (SELECT id FROM tree)
                AND json_extract(p.data, '$.type') = 'tool'
                AND p.time_created >= ${since}) AS calls,
            (SELECT coalesce(sum(json_extract(m.data, '$.cost')), 0) FROM message m
              WHERE m.session_id IN (SELECT id FROM tree)
                AND json_extract(m.data, '$.role') = 'assistant'
                AND m.time_created >= ${since}) AS cost`,
    )
    .pipe(
      Effect.map((rows): TaskContract.Usage => ({ tool_calls: Number(rows[0]?.calls ?? 0), cost_usd: Number(rows[0]?.cost ?? 0) })),
    )
