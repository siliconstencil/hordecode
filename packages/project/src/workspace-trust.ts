import path from "path"
import os from "os"
import { realpathSync } from "fs"
import { Filesystem } from "@opencode-ai/core/util"
import { Path as GlobalPath } from "@opencode-ai/global"
import { Flock } from "@opencode-ai/shared/util/flock"

export type TrustLevel = "trusted" | "untrusted" | "dangerous"
export type TrustRefusalReason = "filesystem-root" | "home-directory" | "home-ancestor"
export type TrustWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already" }
  | { readonly status: "refused"; readonly reason: TrustRefusalReason }

const STORE_FILE = path.join(GlobalPath.data, "trusted-workspaces.json")
const LOCK_NAME = `workspace-trust:${STORE_FILE}`

async function readStore(): Promise<string[]> {
  const text = await Filesystem.readText(STORE_FILE).catch(() => "")
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed.trustedPaths) ? parsed.trustedPaths : []
}

async function writeStore(trustedPaths: string[]) {
  await Filesystem.write(STORE_FILE, JSON.stringify({ version: 1, trustedPaths }, null, 2))
}

// K4: trust keys are filesystem-real paths. A symlinked project directory resolves
// to its target on write and on check, so repointing the link afterwards does not
// inherit trust for the new target. Missing paths (the store also answers for
// directories that do not exist yet) fall back to the resolved path.
function trustPath(directory: string): string {
  const resolved = path.resolve(directory)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function homeCandidates(): string[] {
  return [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : undefined,
    os.homedir(),
  ].filter(Boolean) as string[]
}

// K3: refuse the root and anything that would trust more than one project. A trust
// entry covers the path and every descendant (checkTrust:38-40), so "/" covers the
// machine and $HOME covers every project under it; an ancestor of $HOME does the same
// (K2 Minor 2). Upstream 1.19.5 has no workspace trust store.
// K4: compare real paths, so a home ancestor reached through a symlink is refused
// the same way as the literal path.
function trustRefusal(normalized: string): TrustRefusalReason | undefined {
  if (path.parse(normalized).root === normalized) return "filesystem-root"
  for (const home of homeCandidates()) {
    const resolved = trustPath(home)
    if (resolved === normalized) return "home-directory"
    if (resolved.startsWith(normalized + path.sep)) return "home-ancestor"
  }
  return undefined
}

export async function checkTrust(directory: string): Promise<TrustLevel> {
  // K4: the record is keyed by the real path of the worktree (ruling 6).
  const normalized = trustPath(directory)

  // Detect home directory: Unix ($HOME), Windows (%USERPROFILE%, %HOMEDRIVE%%HOMEPATH%)
  const homes = homeCandidates()
  const isHome = homes.some((h) => trustPath(h) === normalized)
  const isRoot = path.parse(normalized).root === normalized
  if (isHome || isRoot) return "dangerous"

  const trustedPaths = await readStore()
  const isTrusted = trustedPaths.some(
    (trusted) => normalized === trusted || normalized.startsWith(trusted + path.sep),
  )
  return isTrusted ? "trusted" : "untrusted"
}

export async function markTrusted(directory: string): Promise<TrustWriteResult> {
  // K4: write the real path, so a symlinked project records its target (ruling 6).
  const normalized = trustPath(directory)
  const refusal = trustRefusal(normalized)
  if (refusal) return { status: "refused", reason: refusal }
  return Flock.withLock(LOCK_NAME, async (): Promise<TrustWriteResult> => {
    const trustedPaths = await readStore()
    if (trustedPaths.includes(normalized)) return { status: "already" }
    trustedPaths.push(normalized)
    await writeStore(trustedPaths)
    return { status: "written" }
  })
}

export async function listTrusted(): Promise<string[]> {
  return readStore()
}

export async function revokeTrust(directory: string) {
  // K4: revoke the same real path the write recorded (ruling 6).
  const normalized = trustPath(directory)
  await Flock.withLock(LOCK_NAME, async () => {
    const trustedPaths = await readStore()
    await writeStore(trustedPaths.filter((p) => p !== normalized))
  })
}
