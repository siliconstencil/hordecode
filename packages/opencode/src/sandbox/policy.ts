import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { Network, Policy } from "./types"

export class PolicyError extends Error {
  readonly _tag = "SandboxPolicyError"
}

// Locations no sandboxed command may see: credentials, memory and logs live under the data directory.
export const protectedRoots = () => [Global.Path.data]

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// A grant that is, contains or lies inside a protected root would expose it. `hostTmp` says whether the
// scratch directory is a real host directory (Landlock) or a private tmpfs (bwrap).
export function assertSafe(policy: Policy, options: { roots?: string[]; hostTmp?: boolean } = {}) {
  const roots = options.roots ?? protectedRoots()
  const grants = [
    ...policy.readonly,
    ...policy.readwrite,
    ...policy.homeAllow,
    ...(options.hostTmp === false ? [] : [policy.tmp]),
  ]
  for (const grant of grants) {
    for (const root of roots) {
      if (inside(root, grant) || inside(grant, root)) {
        throw new PolicyError(`sandbox policy grants ${grant}, which overlaps the protected path ${root}`)
      }
    }
  }
}

const SYSTEM = ["/usr", "/etc", "/opt", "/lib", "/lib64", "/bin", "/sbin"]

// Splits the system directories that exist into plain read-only binds and merged-usr symlinks.
export function systemLayout(
  exists: (dir: string) => boolean = fs.existsSync,
  link: (dir: string) => string | undefined = (dir) => {
    try {
      return fs.readlinkSync(dir)
    } catch {
      return undefined
    }
  },
) {
  const readonly: string[] = []
  const symlinks: Array<[string, string]> = []
  for (const dir of SYSTEM) {
    if (!exists(dir)) continue
    const target = link(dir)
    if (target) symlinks.push([target, dir])
    else readonly.push(dir)
  }
  return { readonly, symlinks }
}

export function makePolicy(input: {
  worktree: string
  cwd?: string
  home: string
  network?: Network
  readwrite?: string[]
  homeAllow?: string[]
  tmp?: string
  layout?: ReturnType<typeof systemLayout>
}): Policy {
  const layout = input.layout ?? systemLayout()
  const policy: Policy = {
    cwd: input.cwd ?? input.worktree,
    worktree: input.worktree,
    home: input.home,
    readonly: layout.readonly,
    symlinks: layout.symlinks,
    readwrite: [input.worktree, ...(input.readwrite ?? [])],
    homeAllow: input.homeAllow ?? [],
    network: input.network ?? "none",
    tmp: input.tmp ?? "/tmp",
  }
  assertSafe(policy, { hostTmp: false })
  return policy
}
