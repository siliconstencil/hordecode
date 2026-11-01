import { afterAll, describe, expect, test } from "bun:test"
// Project must load first: its module graph is circular and only resolves when entered at project.
import { Project } from "@opencode-ai/project"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { NodePath } from "@effect/platform-node"
import { InstanceRef } from "@opencode-ai/core/effect/instance-ref"
import * as CrossSpawnSpawner from "@opencode-ai/core/effect/cross-spawn-spawner"
import { defaultLayer as gitDefaultLayer } from "@opencode-ai/core/git/index"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Worktree, CreateInput, Info, NotGitError, RemoveFailedError } from "../src/index"

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-pkg-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })
    .toString()
    .trim()

let n = 0
const repo = () => {
  const dir = path.join(base, `repo-${n++}`)
  mkdirSync(dir)
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "t@example.invalid")
  git(dir, "config", "user.name", "t")
  writeFileSync(path.join(dir, "a.txt"), "a")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "init")
  return dir
}

const projectMock = Layer.succeed(Project.Service, { addSandbox: () => Effect.void } as unknown as Project.Interface)
const live = Worktree.layer.pipe(
  Layer.provide(gitDefaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(projectMock),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
)

const instance = (dir: string, vcs: "git" | "none" = "git") =>
  ({ directory: dir, worktree: dir, project: { id: "proj-wt", vcs: vcs === "git" ? "git" : undefined, worktree: dir, sandboxes: [] } }) as never

const run = <A>(dir: string, effect: Effect.Effect<A, unknown, Worktree.Service>, vcs: "git" | "none" = "git") =>
  Effect.runPromise(effect.pipe(Effect.provide(live), Effect.provideService(InstanceRef, instance(dir, vcs))))

const runExit = <A>(dir: string, effect: Effect.Effect<A, unknown, Worktree.Service>, vcs: "git" | "none" = "git") =>
  Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(live), Effect.provideService(InstanceRef, instance(dir, vcs)))))

describe("schemas and errors", () => {
  test("Info and the inputs validate their shape", () => {
    expect(Info.safeParse({ name: "n", branch: "hordecode/n", directory: "/d" }).success).toBe(true)
    expect(Info.safeParse({ name: "n" }).success).toBe(false)
    expect(CreateInput.safeParse({}).success).toBe(true)
    expect(CreateInput.safeParse({ name: "x", startCommand: "bun i" }).success).toBe(true)
  })

  test("named errors carry their name and data", () => {
    expect(new NotGitError({ message: "m" }).toObject()).toEqual({ name: "WorktreeNotGitError", data: { message: "m" } })
    expect(RemoveFailedError.isInstance(new RemoveFailedError({ message: "x" }))).toBe(true)
    expect(Worktree.Event.Ready.type).toBe("worktree.ready")
    expect(Worktree.Event.Failed.type).toBe("worktree.failed")
  })
})

describe("Worktree.makeWorktreeInfo", () => {
  test("names the worktree after the slugified request on a hordecode/ branch under the data directory", async () => {
    const dir = repo()
    const info = await run(dir, Worktree.Service.use((svc) => svc.makeWorktreeInfo("Fix The Bug!")))
    expect(info.name).toBe("fix-the-bug")
    expect(info.branch).toBe("hordecode/fix-the-bug")
    expect(info.directory).toStartWith(path.join(process.env.HORDECODE_HOME as string, "data", "worktree", "proj-wt"))
  })

  test("a taken branch gets a suffixed name instead of a collision", async () => {
    const dir = repo()
    git(dir, "branch", "hordecode/taken")
    const info = await run(dir, Worktree.Service.use((svc) => svc.makeWorktreeInfo("taken")))
    expect(info.name).toStartWith("taken-")
    expect(info.branch).toBe(`hordecode/${info.name}`)
  })

  test("without a name a generated adjective-noun slug is used", async () => {
    const info = await run(repo(), Worktree.Service.use((svc) => svc.makeWorktreeInfo()))
    expect(info.name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test("a non-git project is refused", async () => {
    const exit = await runExit(base, Worktree.Service.use((svc) => svc.makeWorktreeInfo("x")), "none")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && NotGitError.isInstance(Cause.squash(exit.cause))).toBe(true)
  })
})

describe("Worktree.head and isPristine", () => {
  test("head is the checked-out commit and isPristine needs a clean tree on that commit", async () => {
    const dir = repo()
    const tip = git(dir, "rev-parse", "HEAD")
    const out = await run(
      dir,
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const head = yield* svc.head(dir)
        const clean = yield* svc.isPristine(dir, tip)
        writeFileSync(path.join(dir, "dirty.txt"), "x")
        const dirty = yield* svc.isPristine(dir, tip)
        rmSync(path.join(dir, "dirty.txt"))
        const otherBase = yield* svc.isPristine(dir, "0".repeat(40))
        return { head, clean, dirty, otherBase }
      }),
    )
    expect(out).toEqual({ head: tip, clean: true, dirty: false, otherBase: false })
  })

  test("a directory that is not a repository is never pristine", async () => {
    const plain = path.join(base, "plain")
    mkdirSync(plain)
    expect(await run(plain, Worktree.Service.use((svc) => svc.isPristine(plain, "abc")))).toBe(false)
  })
})

describe("Worktree.remove", () => {
  test("removes a linked worktree and its branch", async () => {
    const dir = repo()
    const wt = path.join(base, "linked-wt")
    git(dir, "worktree", "add", "-q", "-b", "hordecode/linked", wt)
    const removed = await run(dir, Worktree.Service.use((svc) => svc.remove({ directory: wt })))
    expect(removed).toBe(true)
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(wt)
    expect(git(dir, "branch", "--list", "hordecode/linked")).toBe("")
  })

  test("a non-git project is refused", async () => {
    const exit = await runExit(base, Worktree.Service.use((svc) => svc.remove({ directory: base })), "none")
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
