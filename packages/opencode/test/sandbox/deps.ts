import type { Deps, RunResult } from "../../src/sandbox/types"

export type Call = { file: string; args: string[] }

export function fakeDeps(
  overrides: Partial<Deps> & { runs?: Record<string, Partial<RunResult>> } = {},
): Deps & { calls: Call[]; abiCalls: { count: number } } {
  const calls: Call[] = []
  const abiCalls = { count: 0 }
  const { runs = {}, ...rest } = overrides
  return {
    platform: "linux",
    execPath: "/opt/hordecode/horde",
    which: (command) => (command === "bwrap" ? "/usr/bin/bwrap" : undefined),
    run: async (file, args) => {
      calls.push({ file, args })
      const key = args[0] === "--version" ? "version" : "probe"
      return { code: 0, stdout: key === "version" ? "bubblewrap 0.9.0\n" : "", stderr: "", ...runs[key] }
    },
    landlockAbi: async () => {
      abiCalls.count++
      return { abi: 7 }
    },
    ...rest,
    calls,
    abiCalls,
  }
}
