import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Session } from "@/session/session"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"
import { provideTmpdirServer } from "../fixture/fixture"
import { itWorkflow as it } from "../lib/tool-cost-harness"

it.live(
  "non-git: the runtime workspace defaults to the instance directory",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf anchor",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const script = [
          `export const meta = { name: "anchor", description: "d" }`,
          `await writeFile("probe.txt", "ok")`,
          `return "ok"`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentSupervisorID: "main" })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "probe.txt")).text())).toBe("ok")
      }),
      { git: false },
    ),
  30000,
)
