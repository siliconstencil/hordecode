import { assertSafe } from "./policy"
import type { Deps, Detection, Driver, Policy } from "./types"

// Arguments for the system `bwrap` binary: private mounts, no host environment beyond the grants.
export function args(policy: Policy): string[] {
  assertSafe(policy, { hostTmp: false })
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(policy.network === "host" ? ["--share-net"] : []),
    ...policy.readonly.flatMap((dir) => ["--ro-bind", dir, dir]),
    ...policy.symlinks.flatMap(([target, link]) => ["--symlink", target, link]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    policy.tmp,
    "--tmpfs",
    policy.home,
    ...policy.homeAllow.flatMap((dir) => ["--ro-bind", dir, dir]),
    ...policy.readwrite.flatMap((dir) => ["--bind", dir, dir]),
    "--chdir",
    policy.cwd,
    "--setenv",
    "HOME",
    policy.home,
    "--setenv",
    "TMPDIR",
    policy.tmp,
  ]
}

async function probe(deps: Deps): Promise<Detection> {
  if (deps.platform !== "linux") return { available: false, reason: "platform", detail: deps.platform }
  const bin = deps.which("bwrap")
  if (!bin) return { available: false, reason: "missing" }
  const version = await deps.run(bin, ["--version"], 2000)
  if (version.code !== 0) return { available: false, reason: "missing", detail: version.stderr.trim().slice(0, 200) }
  const number = /bubblewrap\s+(\S+)/.exec(version.stdout)?.[1]
  // One real namespace setup: user namespaces can be disabled or restricted even when the binary exists.
  const run = await deps.run(bin, ["--unshare-all", "--ro-bind", "/", "/", "/bin/true"], 2000)
  if (run.code !== 0) {
    return { available: false, reason: "userns", detail: run.stderr.trim().slice(0, 200), version: number }
  }
  return { available: true, version: number }
}

export function create(deps: Deps): Driver {
  let detection: Promise<Detection> | undefined
  return {
    name: "bwrap",
    detect: () => (detection ??= probe(deps)),
    args,
    wrap: ({ shell, command, policy }) => ({ file: "bwrap", args: [...args(policy), "--", shell, "-c", command] }),
  }
}
