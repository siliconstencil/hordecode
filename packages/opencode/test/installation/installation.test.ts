import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation, RELEASE_BASE, RELEASE_API, INSTALL_SCRIPT, PACKAGE_NAME } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    testEffect(testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))).effect(
      "reads release version from GitHub releases",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("unknown")
          expect(result).toBe("1.2.3")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))).effect(
      "strips v prefix from GitHub release tag",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("curl")
          expect(result).toBe("4.0.0-beta.1")
        }),
    )

    for (const method of ["npm", "pnpm", "bun"] as const) {
      const calls: string[] = []
      testEffect(
        testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ version: "2.3.4" })
        }),
      ).effect(`latest() with ${method} resolves ${PACKAGE_NAME}@${InstallationChannel} from the npm registry`, () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest(method)
          expect(result).toBe("2.3.4")
          expect(calls.some((url) => url.endsWith(`/${PACKAGE_NAME}/${InstallationChannel}`))).toBe(true)
        }),
      )
    }

    testEffect(testLayer(() => jsonResponse({ version: "2.3.4" }))).effect("scoop is unsupported by Hordecode", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.latest("scoop"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toContain("Scoop is not supported")
      }),
    )

    // Release channel: when method detection falls through (curl/install-script
    // path), the GitHub lookup must hit the Hordecode release endpoint, never the
    // upstream OpenCode one. Verifies the single-source RELEASE_API constant.
    const curlCalls: string[] = []
    testEffect(
      testLayer((request) => {
        curlCalls.push(request.url)
        return jsonResponse({ tag_name: "v0.1.0" })
      }),
    ).effect("latest() with curl method resolves from Hordecode release API", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("0.1.0")
        expect(curlCalls).toContain(RELEASE_API)
        expect(RELEASE_BASE).toBe("https://github.com/siliconstencil/hordecode")
      }),
    )

    const fallbackCalls: string[] = []
    testEffect(
      testLayer((request) => {
        fallbackCalls.push(request.url)
        return jsonResponse({ tag_name: "v0.1.0" })
      }),
    ).effect("latest() falls through to Hordecode release API for unknown methods", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe("0.1.0")
        expect(fallbackCalls).toContain(RELEASE_API)
      }),
    )

    testEffect(testLayer(() => jsonResponse({}))).effect(
      "latest() returns typed error when release has no tag_name",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.latest("curl"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain("no tag_name")
          expect(error.stderr).toContain(RELEASE_API)
        }),
    )

    testEffect(testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))).effect(
      "chocolatey is unsupported by Hordecode",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.latest("choco"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain("Chocolatey is not supported")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ versions: { stable: "2.0.0" } }))).effect(
      "brew is unsupported by Hordecode (no tap)",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.latest("brew"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain("Homebrew tap is not supported")
        }),
    )
  })

  describe("upgrade", () => {
    for (const method of ["npm", "pnpm", "bun"] as const) {
      const spawned: string[] = []
      testEffect(
        testLayer(
          () => jsonResponse({}),
          (cmd, args) => {
            spawned.push([cmd, ...args].join(" "))
            return ""
          },
        ),
      ).effect(`${method} upgrade installs ${PACKAGE_NAME}@<target> globally`, () =>
        Effect.gen(function* () {
          yield* Installation.use.upgrade(method, "9.9.9")
          expect(spawned).toContain(`${method} install -g ${PACKAGE_NAME}@9.9.9`)
        }),
      )
    }

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => (cmd === "npm" && args[0] === "install" ? { code: 1, stderr: "EACCES" } : ""),
      ),
    ).effect("npm upgrade surfaces a typed error when the package manager fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toContain("Upgrade failed for npm (exit code 1)")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script with token=secret", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash" || cmd === "sh") return { code: 1, stderr: "script output with token=secret" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors when the curl install script fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("script output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return { code: 1, stderr: "missing" }
          if (cmd === "bash") return { code: 1, stderr: "should not execute installer with bash" }
          if (cmd === "sh") return "ok"
          return ""
        },
      ),
    ).effect("falls back to sh when bash is unavailable during curl upgrade", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
      }),
    )

    // Release channel: curl upgrade must pull the install script from
    // RELEASE_BASE, not the upstream `https://opencode.ai/install`.
    const curlUpgradeCalls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          curlUpgradeCalls.push(request.url)
          return new Response("install script", { status: 200 })
        },
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash") return { code: 0 }
          if (cmd === process.execPath.split("/").pop()) return "0.1.0"
          return ""
        },
      ),
    ).effect("curl upgrade fetches install script from Hordecode release channel", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
        expect(curlUpgradeCalls).toContain(INSTALL_SCRIPT)
      }),
    )
  })
})
