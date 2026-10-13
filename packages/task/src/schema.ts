import z from "zod"
import { Schema } from "effect"
import { SessionID } from "@opencode-ai/core/session/schema"

export const TaskID = z.string().regex(/^T\d+(\.\d+)*$/, "Task ID must be Tn or Tn.m...")
export type TaskID = z.infer<typeof TaskID>

export const TaskStatus = z.enum(["open", "in_progress", "blocked", "done", "abandoned"])
export type TaskStatus = z.infer<typeof TaskStatus>

export const Task = z.object({
  id: TaskID,
  session_id: z.string(),
  parent_task_id: TaskID.optional(),
  status: TaskStatus,
  summary: z.string(),
  owner: z.string().optional(),
  created_at: z.number(),
  last_event_at: z.number(),
  ended_at: z.number().optional(),
  cleanup_after: z.number().optional(),
})
export type Task = z.infer<typeof Task>

export const Info = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  parent_task_id: Schema.String.pipe(Schema.optional),
  status: Schema.Literals(["open", "in_progress", "blocked", "done", "abandoned"]),
  summary: Schema.String,
  owner: Schema.String.pipe(Schema.optional),
  created_at: Schema.Number,
  last_event_at: Schema.Number,
  ended_at: Schema.Number.pipe(Schema.optional),
  cleanup_after: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "Task" })
export type Info = typeof Info.Type

export const TaskEventKind = z.enum([
  "created",
  "started",
  "unstarted",
  "blocked",
  "unblocked",
  "done",
  "abandoned",
  "renamed",
])
export type TaskEventKind = z.infer<typeof TaskEventKind>

export const TaskEvent = z.object({
  id: z.number(),
  task_id: TaskID,
  at: z.number(),
  kind: TaskEventKind,
  summary: z.string().optional(),
})
export type TaskEvent = z.infer<typeof TaskEvent>
