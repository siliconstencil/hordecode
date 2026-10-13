import { LocalContext } from "@opencode-ai/core/util"
import type { WorkspaceID } from "./schema"

export interface WorkspaceContext {
  workspaceID: WorkspaceID | undefined
}

const context = LocalContext.create<WorkspaceContext>("instance")

export const WorkspaceContext = {
  async provide<R>(input: { workspaceID?: WorkspaceID; fn: () => R }): Promise<R> {
    return context.provide({ workspaceID: input.workspaceID }, () => input.fn())
  },

  restore<R>(workspaceID: WorkspaceID, fn: () => R): R {
    return context.provide({ workspaceID }, fn)
  },

  get workspaceID() {
    try {
      return context.use().workspaceID
    } catch {
      return undefined
    }
  },
}
