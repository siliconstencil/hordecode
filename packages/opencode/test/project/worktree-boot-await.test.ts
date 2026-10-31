import { describe, expect } from "bun:test"
import { $ } from "bun"
import { existsSync } from "fs"
import path from "path"
import { writeFile } from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [Location.node, Location.boundNode(Location.Ref.make({ directory: process.cwd() as Location.Ref["directory"] }))],
  ]),
)
const linuxOnly = process.platform === "win32" ? it.instance.skip : it.instance

// A session started in a fresh worktree reads files immediately, so createFromInfo must not return
// while the checkout is still empty (setup adds the worktree with --no-checkout).
describe("Worktree.createFromInfo", () => {
  linuxOnly(
    "returns with the checkout populated",
    () =>
      Effect.gen(function* () {
        const root = (yield* TestInstance).directory
        yield* Effect.promise(async () => {
          await writeFile(path.join(root, "tracked.txt"), "content\n")
          await $`git add tracked.txt && git -c user.email=t@example.invalid -c user.name=t commit -q -m tracked`.cwd(root).quiet()
        })
        const svc = yield* Worktree.Service
        const info = yield* svc.makeWorktreeInfo({ name: "await-boot" })

        yield* svc.createFromInfo(info)

        expect(existsSync(path.join(info.directory, "tracked.txt"))).toBe(true)
        yield* svc.remove({ directory: info.directory })
      }),
    { git: true },
  )

  linuxOnly(
    "does not wait for the project start command",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const info = yield* svc.makeWorktreeInfo({ name: "start-cmd" })
        const started = Date.now()

        yield* svc.createFromInfo(info, "sleep 3")

        expect(Date.now() - started).toBeLessThan(2500)
        yield* svc.remove({ directory: info.directory })
      }),
    { git: true },
  )
})
