import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@opencode-ai/core/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

// npm package that carries the CLI (upstream: "opencode-ai" at installation/index.ts:200,229,272;
// MiMo: PACKAGE_NAME "@mimo-ai/cli" at installation/index.ts:18). Method detection, the registry
// version lookup and the npm/pnpm/bun upgrade commands all use this name.
export const PACKAGE_NAME = "hordecode"

// Single source of truth for the Hordecode release channel. Override via
// `HORDECODE_RELEASE_BASE` for self-hosted/private mirrors. Release downloads
// (the install script, third-party tooling) resolve from this constant.
const DEFAULT_RELEASE_BASE = "https://github.com/siliconstencil/hordecode"
export const RELEASE_BASE = (process.env.HORDECODE_RELEASE_BASE ?? DEFAULT_RELEASE_BASE).replace(/\/+$/, "")
// JSON endpoint for the latest release. github.com/<repo>/releases/latest is an HTML redirect; the
// tag_name JSON lives on api.github.com (upstream installation/index.ts:258, install:185).
const DEFAULT_RELEASE_API = "https://api.github.com/repos/siliconstencil/hordecode/releases/latest"
export const RELEASE_API = process.env.HORDECODE_RELEASE_API ?? DEFAULT_RELEASE_API
// Install script the curl upgrade path re-runs (README "Installation"; upstream fetches
// https://opencode.ai/install at installation/index.ts:147).
const DEFAULT_INSTALL_SCRIPT = "https://raw.githubusercontent.com/siliconstencil/hordecode/main/install"
export const INSTALL_SCRIPT = process.env.HORDECODE_INSTALL_SCRIPT ?? DEFAULT_INSTALL_SCRIPT

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `hordecode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.optional(Schema.String) })
const NpmPackage = Schema.Struct({ version: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info, UpgradeFailedError>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string, UpgradeFailedError>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      // Hordecode ships without a Homebrew tap. Surface an explicit
      // "unsupported" outcome instead of silently matching the upstream
      // `anomalyco/tap/opencode` (which would point the upgrade path at the
      // wrong repository).
      return "unsupported" as const
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(HttpClientRequest.get(INSTALL_SCRIPT))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const latestImpl = Effect.fn("Installation.latest.unsafe")(function* (installMethod?: Method) {
      const detectedMethod = installMethod || (yield* result.method())

      if (detectedMethod === "brew") {
        return yield* new UpgradeFailedError({
          stderr: "Homebrew tap is not supported by Hordecode -- install via npm/curl or build from source.",
        })
      }

      // Registry lookup for package-manager installs (upstream installation/index.ts:227-235; MiMo
      // installation/index.ts:272-283). The channel dist-tag ("latest") resolves the current version.
      if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
        const registry = yield* NpmConfig.registry(process.cwd())
        const url = `${registry}/${PACKAGE_NAME}/${InstallationChannel}`
        const response = yield* httpOk.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson))
        const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response).pipe(
          Effect.mapError(
            (cause) =>
              new UpgradeFailedError({
                stderr: `failed to resolve latest version from ${url}: ${errorMessage(cause)}`,
              }),
          ),
        )
        return data.version
      }

      if (detectedMethod === "choco") {
        return yield* new UpgradeFailedError({
          stderr: "Chocolatey is not supported by Hordecode -- install via npm/curl or build from source.",
        })
      }

      if (detectedMethod === "scoop") {
        return yield* new UpgradeFailedError({
          stderr: "Scoop is not supported by Hordecode -- install via npm/curl or build from source.",
        })
      }

      const response = yield* httpOk.execute(HttpClientRequest.get(RELEASE_API).pipe(HttpClientRequest.acceptJson))
      const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response).pipe(
        Effect.mapError(
          (cause) =>
            new UpgradeFailedError({
              stderr: `failed to resolve latest version from ${RELEASE_API}: ${errorMessage(cause)}`,
            }),
        ),
      )
      if (!data.tag_name) {
        return yield* new UpgradeFailedError({
          stderr: `release at ${RELEASE_API} has no tag_name -- Hordecode releases must publish a vX.Y.Z tag`,
        })
      }
      return data.tag_name.replace(/^v/, "")
    })

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".hordecode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          // Probes use the fork's package name; no brew formula, scoop manifest or choco package exists yet, so these fall through to curl or npm detection.
          { name: "brew", command: () => text(["brew", "list", "--formula", "hordecode"]) },
          { name: "scoop", command: () => text(["scoop", "list", "hordecode"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output", "hordecode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          // `npm list -g` prints "hordecode@x.y.z" (upstream matches "opencode-ai" at :200).
          if (output.includes(PACKAGE_NAME)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        return yield* latestImpl(installMethod).pipe(
          Effect.mapError(
            (cause) =>
              new UpgradeFailedError({
                stderr: cause instanceof UpgradeFailedError ? cause.stderr : errorMessage(cause),
              }),
          ),
        )
      }),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          // upstream installation/index.ts:271-279; MiMo installation/index.ts:327-333
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "brew":
            return yield* new UpgradeFailedError({
              stderr: "Homebrew tap is not supported by Hordecode -- install via npm/curl or build from source.",
            })
          case "choco":
            return yield* new UpgradeFailedError({
              stderr: "Chocolatey is not supported by Hordecode -- install via npm/curl or build from source.",
            })
          case "scoop":
            return yield* new UpgradeFailedError({
              stderr: "Scoop is not supported by Hordecode -- install via npm/curl or build from source.",
            })
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        yield* Effect.logInfo("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
