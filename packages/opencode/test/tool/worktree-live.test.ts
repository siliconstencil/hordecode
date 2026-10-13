import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// task Finding #4 live evidence (real git): drive the REAL Worktree.Service
// through the same create -> remove lifecycle the session `isolate`/`cancel`
// actions use, on a real git repo in an isolated worktree, and prove the
// worktree directory + branch are gone after remove via `git worktree list`
// and `ls`. The session action -> Worktree.Service.remove wiring is asserted
// separately in test/tool/session.test.ts ("task cancel worktree removal").
const it = testEffect(
  AppNodeBuilder.build(Worktree.node, [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [Location.node, Location.boundNode(Location.Ref.make({ directory: process.cwd() as Location.Ref["directory"] }))],
  ]),
)
const linuxOnly = process.platform === "win32" ? it.instance.skip : it.instance

function gitWorktreeList(root: string): Promise<string> {
  return $`git worktree list --porcelain`.cwd(root).quiet().text()
}

function dirExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

describe("live: real Worktree create -> remove (isolate/cancel lifecycle)", () => {
  linuxOnly(
    "create a real worktree then remove it via Worktree.Service.remove",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        const svc = yield* Worktree.Service

        const info = yield* svc.create({ name: "live-child" })
        const wtDir = info.directory
        const branch = info.branch ?? ""

        // Real worktree now exists (this is the `isolate` creation leg).
        const before = yield* Effect.promise(() => gitWorktreeList(root))
        console.log("before: git worktree list --porcelain\n" + before)
        console.log(
          "before: ls " +
            wtDir +
            " -> " +
            (yield* Effect.promise(() => fs.readdir(wtDir).catch(() => ["<error>"]))).join(" "),
        )
        expect(before).toContain(`worktree ${wtDir}`)
        expect(yield* Effect.promise(() => dirExists(wtDir))).toBe(true)

        // The worktree is on disk (real working tree created by `isolate`).
        const dirListing = yield* Effect.promise(() => fs.readdir(wtDir).catch(() => []))

        // Cancel leg: the real Worktree.Service.remove (as invoked by the
        // session cancel action) runs `git worktree remove --force` + branch -D.
        const ok = yield* svc.remove({ directory: wtDir })
        expect(ok).toBe(true)

        const after = yield* Effect.promise(() => gitWorktreeList(root))
        console.log("after: git worktree list --porcelain\n" + after)
        console.log(
          "after: ls " +
            wtDir +
            " -> " +
            (yield* Effect.promise(() =>
              fs
                .readdir(wtDir)
                .then(() => "<still-exists>")
                .catch(() => "<removed>"),
            )),
        )
        expect(after).not.toContain(`worktree ${wtDir}`)
        expect(yield* Effect.promise(() => dirExists(wtDir))).toBe(false)

        if (branch) {
          const ref = yield* Effect.promise(() =>
            $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow(),
          )
          expect(ref.exitCode).not.toBe(0)
        }

        expect(dirListing).toBeDefined()
      }),
    { git: true },
    20_000,
  )
})
