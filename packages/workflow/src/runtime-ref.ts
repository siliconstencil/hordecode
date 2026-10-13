import type { Interface as WorkflowRuntimeInterface } from "./runtime"

export const workflowRef: {
  current: WorkflowRuntimeInterface | undefined
} = { current: undefined }
