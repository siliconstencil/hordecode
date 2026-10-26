import { assertSafe } from "./policy"
import type { Deps, Detection, Driver, Policy } from "./types"

const FS_V1 = [
  "execute",
  "write_file",
  "read_file",
  "read_dir",
  "remove_dir",
  "remove_file",
  "make_char",
  "make_dir",
  "make_reg",
  "make_sock",
  "make_fifo",
  "make_block",
  "make_sym",
]

// Rights the kernel can enforce per Landlock ABI (ABI 7 measured on kernel 6.18; the lower thresholds
// come from the kernel documentation).
export const fsRights = (abi: number) => [
  ...FS_V1,
  ...(abi >= 2 ? ["refer"] : []),
  ...(abi >= 3 ? ["truncate"] : []),
  ...(abi >= 5 ? ["ioctl_dev"] : []),
]
export const netRights = (abi: number) => (abi >= 4 ? ["bind_tcp", "connect_tcp"] : [])
export const scopeRights = (abi: number) => (abi >= 6 ? ["abstract_unix_socket", "signal"] : [])

const READ_EXEC = ["execute", "read_file", "read_dir"]

export interface Grant {
  path: string
  access: string[]
}

export interface Ruleset {
  abi: number
  handled: { fs: string[]; net: string[]; scope: string[] }
  grants: Grant[]
  degraded: string[]
}

// Pure translation of a policy to Landlock rights for one ABI. Everything handled and not granted is denied.
export function rules(policy: Policy, abi: number): Ruleset {
  assertSafe(policy)
  const all = fsRights(abi)
  const none = policy.network === "none"
  return {
    abi,
    handled: { fs: all, net: none ? netRights(abi) : [], scope: scopeRights(abi) },
    grants: [
      ...[...policy.readonly, ...policy.homeAllow].map((path) => ({ path, access: READ_EXEC })),
      ...[...policy.readwrite, policy.tmp].map((path) => ({ path, access: all })),
    ],
    degraded: [...(none && abi < 4 ? ["net"] : []), ...(abi < 6 ? ["scope"] : [])],
  }
}

const encode = (policy: Policy) =>
  Buffer.from(
    JSON.stringify({
      v: 1,
      cwd: policy.cwd,
      network: policy.network,
      tmp: policy.tmp,
      grants: [
        ...[...policy.readonly, ...policy.homeAllow].map((path) => ({ path, access: "read-exec" })),
        ...[...policy.readwrite, policy.tmp].map((path) => ({ path, access: "read-write" })),
      ],
    }),
  ).toString("base64url")

// Launcher arguments: the hidden subcommand of the hordecode binary that applies the ruleset and execs the shell.
export function args(policy: Policy): string[] {
  assertSafe(policy)
  return ["__landlock-exec", encode(policy)]
}

async function probe(deps: Deps): Promise<Detection> {
  if (deps.platform !== "linux") return { available: false, reason: "platform", detail: deps.platform }
  const result = await deps.landlockAbi()
  if ("error" in result) return { available: false, reason: result.error, detail: result.detail }
  if (result.abi < 1) return { available: false, reason: "landlock-abi", abi: result.abi }
  return {
    available: true,
    abi: result.abi,
    degraded: [...(result.abi < 4 ? ["net"] : []), ...(result.abi < 6 ? ["scope"] : [])],
  }
}

export function create(deps: Deps): Driver {
  let detection: Promise<Detection> | undefined
  return {
    name: "landlock",
    detect: () => (detection ??= probe(deps)),
    args,
    wrap: ({ shell, command, policy }) => ({ file: deps.execPath, args: [...args(policy), "--", shell, "-c", command] }),
  }
}
