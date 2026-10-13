import { Database, eq } from "@opencode-ai/core/storage"
import { SupervisorTaskLinkTable } from "./supervisor-task-link.sql"
import { Effect } from "effect"
export const linkSupervisorTask = (supervisorID: string, sessionID: string, taskID: string, role: string) =>
  Effect.sync(() => Database.use((db)=>(db).insert(SupervisorTaskLinkTable).values({supervisor_id:supervisorID, session_id:sessionID, task_id:taskID, role, time_created:Date.now(), time_updated:Date.now()}).onConflictDoUpdate({target:[SupervisorTaskLinkTable.supervisor_id, SupervisorTaskLinkTable.task_id], set:{role, time_updated:Date.now()}}).run())).pipe(Effect.ignore)
export const getTaskSupervisors = (taskID: string) => Effect.sync(()=>Database.use((db)=>(db).select().from(SupervisorTaskLinkTable).where(eq(SupervisorTaskLinkTable.task_id, taskID)).all()))
export const listLinksBySession = (sessionID: string) => Effect.sync(()=>Database.use((db)=>(db).select().from(SupervisorTaskLinkTable).where(eq(SupervisorTaskLinkTable.session_id, sessionID)).all()))
export const listAllLinks = () => Effect.sync(()=>Database.use((db)=>(db).select().from(SupervisorTaskLinkTable).all()))
