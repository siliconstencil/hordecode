import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(Agent.node))

// The core task invariant: runtimePermission re-appends hardPermission
// AFTER the user/session merge, so a permissive user override cannot relax an
// agent's hard deny rule. This exercises the real production helper -- every
// permission-evaluation site routes through it -- not a re-implementation.

it.instance("plan agent carries a hardPermission edit block", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    expect(planAgent).toBeDefined()
    expect(planAgent!.hardPermission).toBeDefined()
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.hardPermission!).action).toBe("deny")
  }),
)

it.instance("hardPermission survives an explicit permissive user session override", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    expect(planAgent).toBeDefined()

    // A user/session ruleset that EXPLICITLY allows every edit is the exact
    // override that would defeat plan mode if hardPermission were not
    // re-appended last.
    const permissiveSession: PermissionV1.Ruleset = Permission.fromConfig({ edit: "allow" })
    const effective = Agent.runtimePermission(planAgent!, permissiveSession)

    // Non-plan file: the hard deny still wins over the user's allow.
    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    // Plan file: the hard allow exception still applies, so plan edits work.
    expect(Permission.evaluate("edit", ".opencode/plans/roadmap.md", effective).action).toBe("allow")
  }),
)

it.instance("runtimePermission keeps a hard deny without any session ruleset", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    expect(planAgent).toBeDefined()

    const effective = Agent.runtimePermission(planAgent!)
    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", ".opencode/plans/roadmap.md", effective).action).toBe("allow")
  }),
)
