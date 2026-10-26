export type Mode = "off" | "auto" | "required"
export type DriverName = "bwrap" | "landlock"
export type DriverChoice = "auto" | DriverName
export type Network = "none" | "host"

// What a sandboxed command may see. Paths are absolute and already resolved by the caller.
export interface Policy {
  cwd: string
  worktree: string
  home: string
  // Read-only system directories (bind mounts for bwrap, read and execute grants for Landlock).
  readonly: string[]
  // Merged-usr links as [target, link], for example ["usr/bin", "/bin"].
  symlinks: Array<[string, string]>
  // Read and write grants: the worktree and any approved external directory.
  readwrite: string[]
  // Read-only subpaths of `home` that stay visible.
  homeAllow: string[]
  network: Network
  // Scratch directory the command sees as its temporary directory.
  tmp: string
}

export type UnavailableReason = "platform" | "missing" | "userns" | "landlock-abi" | "launcher"

export interface Detection {
  available: boolean
  reason?: UnavailableReason
  detail?: string
  version?: string
  abi?: number
  // Rights or features the detected kernel is too old to enforce.
  degraded?: string[]
}

export interface Command {
  file: string
  args: string[]
}

export interface Driver {
  readonly name: DriverName
  detect(): Promise<Detection>
  // Launcher arguments that carry the policy, without the command itself.
  args(policy: Policy): string[]
  wrap(input: { shell: string; command: string; policy: Policy }): Command
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

// System access behind the drivers, replaceable in tests.
export interface Deps {
  platform: NodeJS.Platform
  execPath: string
  which(command: string): string | undefined
  run(file: string, args: string[], timeoutMs: number): Promise<RunResult>
  // Landlock ABI as reported by a throwaway child process; restricting the main process is permanent.
  landlockAbi(): Promise<{ abi: number } | { error: UnavailableReason; detail?: string }>
}
