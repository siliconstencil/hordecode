declare global {
  const HORDECODE_VERSION: string
  const HORDECODE_CHANNEL: string
}

export const InstallationVersion = typeof HORDECODE_VERSION === "string" ? HORDECODE_VERSION : "local"
export const InstallationChannel = typeof HORDECODE_CHANNEL === "string" ? HORDECODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// OpenCode SDK/API version this fork's plugin loader code was written
// against -- the version third-party `@opencode-ai/plugin` consumers need
// installed. Pinned to the frozen upstream base (see `baseline/v1.17.18` tag,
// `packages/plugin/package.json`); re-derive at each future upstream merge,
// not at every build. Distinct from `InstallationVersion` (Hordecode product
// version) and `InstallationPluginVersion` (publishability-gated channel pin).
export const OpenCodePluginApiVersion = "1.17.18"

// True when `v` looks like something npm can resolve as a concrete package
// version (strict semver X.Y.Z with optional pre-release/build, or a known
// dist-tag). Used to gate background `@opencode-ai/plugin` installs so that
// dev/worktree boots whose build-time define never landed (`"local"` fallback)
// and any future misconfigured production build (e.g. pinning a version that
// has not been published) cannot trip `npm install @opencode-ai/plugin@<bogus>`
// -- a fire-and-forget failure that pollutes every boot's log without any
// user-visible value.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/
const DIST_TAG_RE = /^(?:latest|next|beta|rc|alpha)$/
export function isPublishableVersion(v: string): boolean {
  return SEMVER_RE.test(v) || DIST_TAG_RE.test(v)
}

// Pinned version for the background `@opencode-ai/plugin` install. `undefined`
// makes npm resolve to `@latest`. We deliberately drop the pin when the build
// either is a local channel (dev worktrees have no published package) or
// injected an unpublishable version string (see isPublishableVersion).
export const InstallationPluginVersion = InstallationLocal || !isPublishableVersion(InstallationVersion)
  ? undefined
  : InstallationVersion
