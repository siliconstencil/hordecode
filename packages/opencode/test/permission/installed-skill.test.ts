// F7: an edit to an installed harness or research skill is denied; a read is allowed.
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { InstalledSkill } from "../../src/permission/installed-skill"
import { MessageID, SessionID } from "../../src/session/schema"
import { assertExternalDirectoryEffect, assertWriteAllowed } from "../../src/tool/external-directory"
import type * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(Agent.node))

const target = () => path.join(Global.Path.data, "harness", "0.1.6", "skills", "eval", "SKILL.md")

// Mirrors the production ask wrapper: evaluate the request against the effective
// ruleset, deny on a deny rule, and let allow/ask continue without a human.
function gate(ruleset: PermissionV1.Ruleset) {
  const asked: string[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_installed_skill"),
    messageID: MessageID.make("msg_installed_skill"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) => {
      asked.push(req.permission)
      const rule = Permission.evaluate(req.permission, req.patterns[0]!, ruleset)
      if (rule.action === "deny") return Effect.die(new PermissionV1.DeniedError({ ruleset: [] }))
      return Effect.void
    },
  }
  return { asked, ctx }
}

it.instance("matches the installed harness and research roots only", () =>
  Effect.gen(function* () {
    const harness = path.join(Global.Path.data, "harness", "0.1.6", "skills", "eval", "SKILL.md")
    const research = path.join(Global.Path.data, "research", "0.1.6", "skills", "review", "SKILL.md")
    expect(InstalledSkill.match(harness)).toEqual([harness])
    expect(InstalledSkill.match(research)).toEqual([research])
    expect(InstalledSkill.match(path.join(Global.Path.data, "memory", "note.md"))).toEqual([])
    expect(InstalledSkill.match(path.join(Global.Path.data, "harness-other", "x.md"))).toEqual([])
    expect(InstalledSkill.match(path.join(Global.Path.config, "skills", "mine", "SKILL.md"))).toEqual([])
  }),
)

it.instance("runtimePermission keeps the write lock over a permissive user and session ruleset", () =>
  Effect.gen(function* () {
    const build = yield* Agent.use.get("build")
    const permissive = Permission.fromConfig({
      installed_skill_write: "allow",
      edit: "allow",
      read: "allow",
      external_directory: "allow",
    })
    const effective = Agent.runtimePermission(build!, permissive)
    expect(Permission.evaluate(InstalledSkill.PERMISSION, target(), effective).action).toBe("deny")
    expect(Permission.evaluate("read", target(), effective).action).toBe("allow")
  }),
)

it.instance("the write gate denies an edit to an installed skill while a read is allowed", () =>
  Effect.gen(function* () {
    const build = yield* Agent.use.get("build")
    const effective = Agent.runtimePermission(
      build!,
      Permission.fromConfig({ installed_skill_write: "allow", edit: "allow", read: "allow" }),
    )

    const write = gate(effective)
    const writeExit = yield* assertWriteAllowed(write.ctx, target()).pipe(Effect.exit)
    expect(Exit.isFailure(writeExit)).toBe(true)
    expect(write.asked).toContain(InstalledSkill.PERMISSION)

    const read = gate(effective)
    yield* assertExternalDirectoryEffect(read.ctx, target())
    expect(read.asked).not.toContain(InstalledSkill.PERMISSION)
  }),
)
