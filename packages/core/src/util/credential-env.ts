/**
 * Env vars that carry the user's credentials in cleartext.
 *
 * `OPENCODE_AUTH_CONTENT` / `HORDECODE_AUTH_CONTENT` hold the whole `auth.json` (model provider
 * keys, OAuth refresh tokens); `OPENCODE_CONFIG_CONTENT` / `HORDECODE_CONFIG_CONTENT` can embed
 * MCP `environment` values and request `headers`.
 *
 * Neither may reach a child process the engine spawns. The shell tool and the pty run
 * agent-authored commands, local MCP servers are third-party binaries, and both run as the user --
 * so plain inheritance means `echo $OPENCODE_AUTH_CONTENT` exfiltrates the provider key.
 *
 * Scrub the *inherited* environment only, so a caller that puts credentials in an explicit `env` is
 * still honored. Ported from the upstream credential-env.ts; fork reads the
 * `OPENCODE_*`/`HORDECODE_*` spellings of the same vars.
 */
const CREDENTIAL_ENV = new Set([
  "OPENCODE_AUTH_CONTENT",
  "HORDECODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "HORDECODE_CONFIG_CONTENT",
])

/**
 * Copy of `env` with the credential vars removed.
 *
 * Always hand the result to `spawn` explicitly: leaving `env` undefined makes the child inherit
 * the parent's environment wholesale, credentials included.
 *
 * This closes inheritance, not every path: a child running as the same user can still read
 * `/proc/<parent-pid>/environ`, so a credential that must not leak should not be in the
 * environment at all.
 */
export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CREDENTIAL_ENV.has(key)))
}

/** Credential var names, for tests and diagnostics that must not hardcode the list. */
export function credentialEnvKeys() {
  return [...CREDENTIAL_ENV]
}
