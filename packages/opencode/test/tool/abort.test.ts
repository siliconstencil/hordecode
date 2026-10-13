import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

// Capture the abort signal the tool hands to its ripgrep call. A Layer.mock of
// Ripgrep.Service records the input instead of running a real child process, so
// the test asserts signal passthrough, not merely "it doesn't crash".
let capturedSignal: AbortSignal | undefined

const toolLayer = AppNodeBuilder.build(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
)

const it = testEffect(
  Layer.mergeAll(
    toolLayer,
    Layer.mock(Ripgrep.Service, {
      glob: (input) => {
        capturedSignal = input.signal
        return Effect.succeed([])
      },
      grep: (input) => {
        capturedSignal = input.signal
        return Effect.succeed([])
      },
    }),
  ),
)

function resetCapture() {
  capturedSignal = undefined
}

function makeCtx(abort: AbortSignal): Tool.Context {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort,
    messages: [],
    metadata: () => Effect.void,
    // The mock ripgrep returns immediately; the glob/grep permission ask no-ops
    // like the other tool tests.
    ask: () => Effect.void,
  }
}

describe("tool abort-signal passthrough", () => {
  it.instance("glob forwards ctx.abort to the ripgrep call", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      resetCapture()
      const abort = new AbortController().signal
      const ctx = makeCtx(abort)

      const info = yield* GlobTool
      const glob = yield* info.init()
      yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )

      expect(capturedSignal).toBe(abort)
    }),
  )

  it.instance("grep forwards ctx.abort to the ripgrep call", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      resetCapture()
      const abort = new AbortController().signal
      const ctx = makeCtx(abort)

      const info = yield* GrepTool
      const grep = yield* info.init()
      yield* grep.execute(
        {
          pattern: "needle",
          path: test.directory,
        },
        ctx,
      )

      expect(capturedSignal).toBe(abort)
    }),
  )
})
