import { describe, expect, test } from "bun:test"
import { switchesPatch } from "../../src/component/dialog-switches"

describe("dialog switches", () => {
  test("builds an all-false patch", () => {
    expect(
      switchesPatch({
        workspaces: false,
        orchestrator: false,
        workflow_tool: false,
        cron: false,
        embedding: false,
      }),
    ).toEqual({
      experimental: {
        switches: { workspaces: false, orchestrator: false, workflow_tool: false, cron: false },
      },
      memory: { embedding: false },
    })
  })

  test("builds a mixed patch", () => {
    expect(
      switchesPatch({
        workspaces: true,
        orchestrator: false,
        workflow_tool: true,
        cron: false,
        embedding: true,
      }),
    ).toEqual({
      experimental: {
        switches: { workspaces: true, orchestrator: false, workflow_tool: true, cron: false },
      },
      memory: { embedding: true },
    })
  })
})
