import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { NotebookEditTool } from "../../src/tool/notebook-edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-notebook-edit"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const init = Effect.fn("NotebookEditToolTest.init")(function* () {
  const info = yield* NotebookEditTool
  return yield* info.init()
})

const run = Effect.fn("NotebookEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof NotebookEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  // Editing an .ipynb requires a prior Read (read-gate in notebook-edit.ts).
  // Simulate the Read so the gate passes for real edits.
  const context = withReadFor(args.notebook_path, next)
  return yield* tool.execute(args, context)
})

function withReadFor(filePath: string, base: Tool.Context = ctx): Tool.Context {
  const messageID = MessageID.make("msg_read")
  return {
    ...base,
    messages: [
      {
        info: { id: messageID, sessionID: base.sessionID, role: "assistant" },
        parts: [
          {
            id: PartID.make("prt_read"),
            messageID,
            sessionID: base.sessionID,
            type: "tool",
            tool: "read",
            callID: "call_read",
            state: {
              status: "completed",
              input: { filePath },
              output: "",
              title: `Read ${filePath}`,
              metadata: {},
              time: { start: 0, end: 0 },
            },
          },
        ],
      },
    ] as unknown as Tool.Context["messages"],
  }
}

function notebookJson() {
  return {
    cells: [
      {
        cell_type: "code",
        id: "cell1",
        source: ["print(1)\n"],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }
}

describe("tool.notebook_edit", () => {
  it.instance("publishes file.edited and file.watcher.updated events on successful edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const events = yield* EventV2Bridge.Service
      const filepath = path.join(test.directory, "notebook.ipynb")
      yield* Effect.promise(() => fs.writeFile(filepath, JSON.stringify(notebookJson()), "utf-8"))

      const seen: string[] = []
      const off = yield* events.listen((event) => {
        seen.push(event.type)
        return Effect.void
      })

      const result = yield* run({ notebook_path: filepath, cell_id: "cell1", new_source: "print(2)\n" })

      yield* off

      expect(result.output).toContain("Notebook updated")
      expect(seen).toContain(FileSystem.Event.Edited.type)
      expect(seen).toContain(Watcher.Event.Updated.type)
    }),
  )

  it.instance("asks permission before writing and writes the edited cells to disk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "notebook.ipynb")
      yield* Effect.promise(() => fs.writeFile(filepath, JSON.stringify(notebookJson()), "utf-8"))

      const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const askCtx: Tool.Context = {
        ...ctx,
        ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.sync(() => {
            asks.push(req)
          }),
      }

      const result = yield* run({ notebook_path: filepath, cell_id: "cell1", new_source: "print(2)\n" }, askCtx)

      expect(result.output).toContain("Notebook updated")
      expect(asks.length).toBeGreaterThan(0)
      expect(asks.some((req) => req.permission === "edit")).toBe(true)

      const content = yield* Effect.promise(() => Bun.file(filepath).text())
      const parsed = JSON.parse(content) as { cells: Array<{ id?: string; cell_type?: string; source: string[] }> }
      const cell = parsed.cells.find((c) => c.id === "cell1")
      expect(cell).toBeDefined()
      expect(cell!.source).toEqual(["print(2)\n"])
    }),
  )

  it.instance("errors on a non-.ipynb path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "notebook.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "plain text", "utf-8"))

      const result = yield* run({ notebook_path: filepath, cell_id: "cell1", new_source: "print(2)\n" })

      expect(result.output).toContain("must point to a .ipynb")
    }),
  )
})
