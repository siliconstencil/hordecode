import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { InstanceRef } from "@opencode-ai/core/effect/instance-ref"
import { SessionID } from "@opencode-ai/core/session/schema"
import { Team } from "../src/index"
import { TeamMember } from "../src/schema"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "team-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const instance = { directory: root, worktree: root, project: { id: "proj", worktree: root, sandboxes: [] } } as never

const run = <A>(effect: Effect.Effect<A, unknown, Team.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Team.defaultLayer), Effect.provideService(InstanceRef, instance)))

const sid = (n: number) => SessionID.make(`ses_team_${n}`)

describe("Team", () => {
  test("teamDir is under the instance .hordecode/teams directory", async () => {
    const dir = await run(Effect.gen(function* () {
      const team = yield* Team.Service
      return yield* team.teamDir("alpha")
    }))
    expect(dir).toBe(path.join(root, ".hordecode", "teams", "alpha"))
  })

  test("create writes an empty members file and getMembers reads it", async () => {
    const members = await run(
      Effect.gen(function* () {
        const team = yield* Team.Service
        yield* team.create("t-create", sid(1))
        return yield* team.getMembers("t-create")
      }),
    )
    expect(members).toEqual([])
    expect(readFileSync(path.join(root, ".hordecode", "teams", "t-create", "members.json"), "utf8")).toBe("[]")
  })

  test("addMember records a member once; a second add of the same session is ignored", async () => {
    const members = await run(
      Effect.gen(function* () {
        const team = yield* Team.Service
        yield* team.create("t-add", sid(1))
        yield* team.addMember("t-add", sid(2), "build", "lead")
        yield* team.addMember("t-add", sid(2), "plan", "other")
        yield* team.addMember("t-add", sid(3), "plan", "reviewer")
        return yield* team.getMembers("t-add")
      }),
    )
    expect(members.map((m) => [m.sessionID, m.agent, m.role])).toEqual([
      [sid(2), "build", "lead"],
      [sid(3), "plan", "reviewer"],
    ])
    expect(members.every((m) => TeamMember.safeParse(m).success)).toBe(true)
  })

  test("removeMember drops only that member and is a no-op for an unknown one", async () => {
    const members = await run(
      Effect.gen(function* () {
        const team = yield* Team.Service
        yield* team.create("t-remove", sid(1))
        yield* team.addMember("t-remove", sid(2), "build", "lead")
        yield* team.addMember("t-remove", sid(3), "plan", "reviewer")
        yield* team.removeMember("t-remove", sid(2))
        yield* team.removeMember("t-remove", sid(99))
        return yield* team.getMembers("t-remove")
      }),
    )
    expect(members.map((m) => m.sessionID)).toEqual([sid(3)])
  })

  test("getMembers of a team that was never created is empty", async () => {
    const members = await run(Effect.gen(function* () {
      const team = yield* Team.Service
      return yield* team.getMembers("never-created")
    }))
    expect(members).toEqual([])
  })
})
