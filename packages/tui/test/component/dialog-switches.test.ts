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
        permission_audit: false,
        sandbox: false,
        hashline: false,
        embedding: false,
      }),
    ).toEqual({
      experimental: {
        switches: {
          workspaces: false,
          orchestrator: false,
          workflow_tool: false,
          cron: false,
          permission_audit: false,
          sandbox: false,
          hashline: false,
        },
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
        permission_audit: true,
        sandbox: true,
        hashline: true,
        embedding: true,
      }),
    ).toEqual({
      experimental: {
        switches: {
          workspaces: true,
          orchestrator: false,
          workflow_tool: true,
          cron: false,
          permission_audit: true,
          sandbox: true,
          hashline: true,
        },
      },
      memory: { embedding: true },
    })
  })
})
