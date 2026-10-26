import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { ProtectedPath } from "../../src/permission/protected-path"
import { Plugin } from "../../src/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Request = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

const auth = () => path.join(Global.Path.data, "auth.json")

const ensureAuth = async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  if (!(await Bun.file(auth()).exists())) await Bun.write(auth(), "{}")
}

const layer = Layer.mergeAll(
  AppNodeBuilder.build(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      Git.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(layer)

const stop = new Error("stop after permission")

function capture() {
  const requests: Request[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
        throw stop
      }),
  }
  return { requests, ctx }
}

const shell = (command: string, directory: string) =>
  Effect.gen(function* () {
    const { requests, ctx } = capture()
    const tool = yield* (yield* ShellTool).init()
    const exit = yield* tool.execute({ command, description: "probe" }, ctx).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(stop)
    return requests[0]
  }).pipe(provideInstance(directory))

describe("ProtectedPath.match", () => {
  test("matches the literal path, a symlink to it and a hard link to it", async () => {
    await ensureAuth()
    const dir = await fs.mkdtemp(path.join(Global.Path.tmp, "pp-"))
    await fs.symlink(auth(), path.join(dir, "link.json"))
    await fs.symlink(path.join(dir, "link.json"), path.join(dir, "chain.json"))
    await fs.link(auth(), path.join(dir, "hard.json"))

    expect(ProtectedPath.match(auth())).toBe(auth())
    expect(ProtectedPath.match(path.join(Global.Path.data, ".", "auth.json"))).toBe(auth())
    expect(ProtectedPath.match(path.join(dir, "link.json"))).toBe(auth())
    expect(ProtectedPath.match(path.join(dir, "chain.json"))).toBe(auth())
    expect(ProtectedPath.match(path.join(dir, "hard.json"))).toBe(auth())
    expect(ProtectedPath.match(path.join(Global.Path.data, "other.json"))).toBeUndefined()
    expect(ProtectedPath.match(path.join(dir, "missing.json"))).toBeUndefined()
  })

  test("matches shell words: quotes, flag values, variables and globs", async () => {
    await ensureAuth()
    process.env["PP_TEST_DATA"] = Global.Path.data
    try {
      const cwd = Global.Path.data
      expect(ProtectedPath.matchWord(`'${auth()}'`, "/")).toBe(auth())
      expect(ProtectedPath.matchWord(`--file=${auth()}`, "/")).toBe(auth())
      expect(ProtectedPath.matchWord("auth.json", cwd)).toBe(auth())
      expect(ProtectedPath.matchWord("$PP_TEST_DATA/auth.json", "/")).toBe(auth())
      expect(ProtectedPath.matchWord("${PP_TEST_DATA}/auth.json", "/")).toBe(auth())
      expect(ProtectedPath.matchWord(`${Global.Path.data}/au*`, "/")).toBe(auth())
      expect(ProtectedPath.matchWord(`${Global.Path.data}/*.json`, "/")).toBe(auth())
      expect(ProtectedPath.matchWord(`${Global.Path.data}/*.txt`, "/")).toBeUndefined()
      expect(ProtectedPath.matchWord("$(echo x)", cwd)).toBeUndefined()
    } finally {
      delete process.env["PP_TEST_DATA"]
    }
  })
})

describe("ProtectedPath mcp-auth.json", () => {
  test("is protected like auth.json, by path, symlink and shell word", async () => {
    const mcp = path.join(Global.Path.data, "mcp-auth.json")
    await fs.mkdir(Global.Path.data, { recursive: true })
    if (!(await Bun.file(mcp).exists())) await Bun.write(mcp, "{}")
    const dir = await fs.mkdtemp(path.join(Global.Path.tmp, "pp-mcp-"))
    await fs.symlink(mcp, path.join(dir, "link.json"))

    expect(ProtectedPath.match(mcp)).toBe(mcp)
    expect(ProtectedPath.match(path.join(dir, "link.json"))).toBe(mcp)
    expect(ProtectedPath.matchWord("mcp-auth.json", Global.Path.data)).toBe(mcp)
    expect(ProtectedPath.ruleset().some((rule) => rule.pattern === mcp && rule.action === "deny")).toBe(true)
  })
})

describe("ProtectedPath rules", () => {
  it.instance("runtimePermission denies the file over a permissive user and session ruleset", () =>
    Effect.gen(function* () {
      const build = yield* Agent.use.get("build")
      const permissive = Permission.fromConfig({ "*": "allow", protected_path: "allow", read: "allow" })
      const effective = Agent.runtimePermission(build!, permissive)
      expect(Permission.evaluate(ProtectedPath.PERMISSION, auth(), effective).action).toBe("deny")
      expect(Permission.evaluate("read", auth(), effective).action).toBe("allow")
    }),
  )
})

describe("file tool guard", () => {
  it.live("asks protected_path for a symlink inside the project, before the in-project exemption", () =>
    Effect.gen(function* () {
      yield* Effect.promise(ensureAuth)
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.symlink(auth(), path.join(dir, "creds.json")))
      const { requests, ctx } = capture()
      const exit = yield* assertExternalDirectoryEffect(ctx, path.join(dir, "creds.json"), { bypass: true }).pipe(
        provideInstance(dir),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests[0]?.permission).toBe(ProtectedPath.PERMISSION)
      expect(requests[0]?.patterns).toEqual([auth()])
    }),
  )
})

describe.skipIf(process.platform === "win32")("shell tool", () => {
  const cases = (data: string) => [
    `cat ${data}/auth.json`,
    `cp ${data}/auth.json /tmp/x`,
    `echo '{}' | tee ${data}/auth.json`,
    `echo '{}' > ${data}/auth.json`,
    `echo '{}' >> ${data}/auth.json`,
    `wc -c < ${data}/auth.json`,
    `head -c 10 ${data}/au*.json`,
    `true && cat "${data}/auth.json"`,
  ]

  it.live("asks protected_path for reads, copies, tee and redirects", () =>
    Effect.gen(function* () {
      yield* Effect.promise(ensureAuth)
      const dir = yield* tmpdirScoped({ git: true })
      for (const command of cases(Global.Path.data)) {
        const req = yield* shell(command, dir)
        expect({ command, permission: req?.permission, patterns: req?.patterns }).toEqual({
          command,
          permission: ProtectedPath.PERMISSION,
          patterns: [auth()],
        })
      }
    }),
  )

  it.live("asks protected_path for a project symlink to the file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(ensureAuth)
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.symlink(auth(), path.join(dir, "creds.json")))
      const req = yield* shell("cat creds.json", dir)
      expect(req?.permission).toBe(ProtectedPath.PERMISSION)
    }),
  )

  it.live("leaves ordinary commands to the normal shell ask", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const req = yield* shell("cat README.md", dir)
      expect(req?.permission).toBe("bash")
    }),
  )
})
