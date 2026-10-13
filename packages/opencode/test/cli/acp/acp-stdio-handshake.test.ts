//  `hordecode acp` regression. The user-facing CLI is documented as
// "start ACP (Agent Client Protocol) server" but the original describe
// didn't tell the operator that ACP traffic is stdio NDJSON, not TCP.
// Operators who see `--port`/`--hostname` flags naturally assume ACP is
// exposed over a TCP socket; when their ACP client (Zed, JetBrains, etc.)
// gets no response, the symptom is "exits silently, no port" which is
// the bug report that produced .
//
// These two tests pin both the describe text AND the real handshake so a
// future describe-rewrite can't drop the stdio clarification, and so a
// regression in the stdio pump (e.g. ndJsonStream arg order, stdin not
// resumed, AgentSideConnection callback dropped) breaks a CI test instead
// of producing a silent exit-0 in production.

import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { createAcpClient, initialize } from "./helpers"

describe("opencode acp stdio handshake", () => {
  cliIt.live(
    "`acp --help` describes stdio NDJSON, not a TCP port",
    ({ opencode }) =>
      Effect.gen(function* () {
        // yargs writes --help to stderr, not stdout. COLUMNS=120 keeps the
        // describe-wrap stable so this test isn't sensitive to terminal width.
        const result = yield* opencode.spawn(["acp", "--help"], {
          timeoutMs: 10_000,
          env: { COLUMNS: "120" },
        })
        expect(result.exitCode).toBe(0)
        // The describe text must mention stdio and NDJSON so an operator
        // doesn't waste time trying to connect on the --port number.
        expect(result.stderr).toMatch(/stdio/i)
        expect(result.stderr).toMatch(/NDJSON/i)
        // And it must explicitly tell the operator that --port/--hostname
        // are NOT for ACP traffic, otherwise the bug report recurs.
        expect(result.stderr).toMatch(/--port/)
        expect(result.stderr).toMatch(/--hostname/)
        // Defensive: the bundled hordecode HTTP API mention is what an
        // operator needs to understand the --port flag's real purpose.
        expect(result.stderr).toMatch(/HTTP API/i)
      }),
    30_000,
  )

  cliIt.live(
    "stdio initialize round-trip returns protocolVersion 1 + OpenCode agentInfo",
    ({ opencode }) =>
      Effect.gen(function* () {
        // This is the substantive half of: a real subprocess, real
        // stdin/stdout NDJSON pump, real JSON-RPC initialize handshake.
        // Pre-fix the stdio pump would silently never respond and the
        // AcpClient.request() timeout would fire. Post-fix we get a
        // proper InitializeResponse with the documented capabilities.
        const acp = yield* createAcpClient({ opencode })
        const init = yield* initialize(acp).pipe(Effect.timeout(Duration.seconds(20)))

        expect(init.protocolVersion).toBe(1)
        expect(init.agentInfo?.name).toBe("OpenCode")
        // The handshake must advertise at least one prompt capability --
        // an initialize response with all capabilities false is a real
        // regression even though the JSON parse would succeed.
        expect(init.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true)
      }),
    60_000,
  )
})
