import type { ChildProcessWithoutNullStreams } from "child_process"

export interface Handle {
  process: ChildProcessWithoutNullStreams
  initialization?: Record<string, any>
}
