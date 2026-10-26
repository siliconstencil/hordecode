import { createHash } from "node:crypto"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import fs from "fs"
import path from "path"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Permission } from "../../src/permission"
import { PermissionAudit } from "../../src/permission/audit"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const sessionID = SessionID.make("session_audit")

const clear = () => {
  PermissionAudit.__resetForTest()
  for (const suffix of ["", ".1", ".2", ".3", ".4"]) fs.rmSync(PermissionAudit.file() + suffix, { force: true })
}

const rawLines = (suffix = "") =>
  fs.existsSync(PermissionAudit.file() + suffix)
    ? fs.readFileSync(PermissionAudit.file() + suffix, "utf8").split("\n").filter((line) => line.length > 0)
    : []

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const lines = (suffix = "") =>
  fs.existsSync(PermissionAudit.file() + suffix)
    ? fs
        .readFileSync(PermissionAudit.file() + suffix, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : []

const audited = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      clear()
      process.env["HORDECODE_PERMISSION_AUDIT"] = "1"
    }),
    () => self,
    () => Effect.sync(() => delete process.env["HORDECODE_PERMISSION_AUDIT"]),
  )

const ask = (input: Partial<Parameters<Permission.Interface["ask"]>[0]>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask({
      sessionID,
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
      ...input,
    })
  })

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  while (true) {
    const list = yield* permission.list()
    if (list.length > 0) return list[0]
    yield* Effect.sleep("10 millis")
  }
})

describe("permission audit log", () => {
  it.instance(
    "records rule allow, rule deny and non-interactive deny as decision lines",
    () =>
      audited(
        Effect.gen(function* () {
          yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] })
          yield* ask({ patterns: ["rm x"], ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }).pipe(
            Effect.exit,
          )
          yield* ask({ interactive: false, ruleset: [] }).pipe(Effect.exit)
          expect(lines().map((line) => [line.kind, line.permission, line.patterns, line.outcome])).toEqual([
            ["decision", "bash", ["ls"], "allow"],
            ["decision", "bash", ["rm x"], "deny"],
            ["decision", "bash", ["ls"], "deny_non_interactive"],
          ])
          for (const line of lines()) {
            expect(line.sessionID).toBe(sessionID)
            expect(typeof line.time).toBe("number")
          }
        }),
      ),
    { git: true },
  )

  it.instance(
    "records the human reply and the resulting decision",
    () =>
      audited(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const once = yield* ask({}).pipe(Effect.forkScoped)
          const first = yield* pending
          yield* permission.reply({ requestID: first.id, reply: "once" })
          expect(Exit.isSuccess(yield* Fiber.await(once))).toBe(true)

          const rejected = yield* ask({ patterns: ["pwd"] }).pipe(Effect.forkScoped)
          const second = yield* pending
          yield* permission.reply({ requestID: second.id, reply: "reject", message: "no" })
          expect(Exit.isFailure(yield* Fiber.await(rejected))).toBe(true)

          const byRequest = (id: string) =>
            lines()
              .filter((line) => line.requestID === id)
              .map((line) => `${line.kind}:${line.reply ?? line.outcome}`)
              .sort()
          expect(lines()).toHaveLength(4)
          expect(byRequest(first.id)).toEqual(["decision:allow", "reply:once"])
          expect(byRequest(second.id)).toEqual(["decision:reject_with_feedback", "reply:reject"])
          expect(JSON.stringify(lines())).not.toContain('"no"')
        }),
      ),
    { git: true },
  )

  it.instance(
    "writes nothing when disabled",
    () =>
      Effect.gen(function* () {
        clear()
        delete process.env["HORDECODE_PERMISSION_AUDIT"]
        yield* ask({ ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] })
        expect(fs.existsSync(PermissionAudit.file())).toBe(false)
      }),
    { git: true },
  )
})

describe("permission audit helpers", () => {
  test("redacts credentials in command patterns", () => {
    const out = [
      "curl -H 'Authorization: Bearer sk-live-123' https://api.example.com",
      "GITHUB_TOKEN=ghp_abc123 gh pr list",
      "git clone https://user:hunter2@example.com/repo.git",
      "mysql --password=hunter2 db",
    ].map(PermissionAudit.redact)
    expect(out.join("\n")).not.toMatch(/sk-live-123|ghp_abc123|hunter2/)
    expect(out[0]).toContain("https://api.example.com")
    expect(out[1]).toContain("gh pr list")
  })

  test("rotates by size and keeps three old files", () => {
    clear()
    process.env["HORDECODE_PERMISSION_AUDIT"] = "1"
    process.env["HORDECODE_PERMISSION_AUDIT_MAX_BYTES"] = "400"
    try {
      for (let i = 0; i < 40; i++) PermissionAudit.write({ kind: "decision", n: i, pad: "x".repeat(60) })
      for (const suffix of ["", ".1", ".2", ".3"]) {
        expect(fs.statSync(PermissionAudit.file() + suffix).size).toBeLessThanOrEqual(400)
      }
      expect(fs.existsSync(PermissionAudit.file() + ".4")).toBe(false)
      expect(lines().at(-1).n).toBe(39)
      expect(lines(".1").at(-1).n).toBe(lines()[0].n - 1)
      expect(fs.statSync(PermissionAudit.file()).mode & 0o777).toBe(0o600)
    } finally {
      delete process.env["HORDECODE_PERMISSION_AUDIT"]
      delete process.env["HORDECODE_PERMISSION_AUDIT_MAX_BYTES"]
      clear()
    }
  })
})

describe("permission audit hash chain", () => {
  const logged = (body: () => void) => {
    clear()
    process.env["HORDECODE_PERMISSION_AUDIT"] = "1"
    try {
      body()
    } finally {
      delete process.env["HORDECODE_PERMISSION_AUDIT"]
      clear()
    }
  }

  test("chains three writes from 64 zeros and verifies", () => {
    logged(() => {
      for (let i = 0; i < 3; i++) PermissionAudit.write({ kind: "decision", n: i })
      const raw = rawLines()
      const result = PermissionAudit.verify()
      expect(result).toEqual({ ok: true, files: [PermissionAudit.file()], lines: 3, legacy: 0, anchor: `${PermissionAudit.file()}:1` })
      expect(JSON.parse(raw[0]!).prev).toBe("0".repeat(64))
      expect(JSON.parse(raw[1]!).prev).toBe(sha(raw[0]!))
      expect(JSON.parse(raw[2]!).prev).toBe(sha(raw[1]!))
    })
  })

  test("reports the line after an edited line as a prev mismatch", () => {
    logged(() => {
      for (let i = 0; i < 3; i++) PermissionAudit.write({ kind: "decision", n: i })
      const text = fs.readFileSync(PermissionAudit.file(), "utf8")
      fs.writeFileSync(PermissionAudit.file(), text.replace('"n":1', '"n":2'))
      const result = PermissionAudit.verify()
      expect(result.ok).toBe(false)
      expect(result.broken?.file).toBe(PermissionAudit.file())
      expect(result.broken?.line).toBe(3)
      expect(result.broken?.reason).toContain("prev mismatch")
    })
  })

  test("verifies across rotated files", () => {
    logged(() => {
      process.env["HORDECODE_PERMISSION_AUDIT_MAX_BYTES"] = "400"
      try {
        for (let i = 0; i < 40; i++) PermissionAudit.write({ kind: "decision", n: i, pad: "x".repeat(60) })
      } finally {
        delete process.env["HORDECODE_PERMISSION_AUDIT_MAX_BYTES"]
      }
      const result = PermissionAudit.verify()
      expect(result.ok).toBe(true)
      expect(result.files).toEqual([`${PermissionAudit.file()}.3`, `${PermissionAudit.file()}.2`, `${PermissionAudit.file()}.1`, PermissionAudit.file()])
      expect(result.lines).toBe(rawLines(".1").length + rawLines(".2").length + rawLines(".3").length + rawLines().length)
      expect(result.legacy).toBe(0)
    })
  })

  test("a fresh process continues the chain from the last existing line", () => {
    logged(() => {
      PermissionAudit.write({ kind: "decision", n: 0 })
      PermissionAudit.write({ kind: "decision", n: 1 })
      PermissionAudit.__resetForTest()
      PermissionAudit.write({ kind: "decision", n: 2 })
      const raw = rawLines()
      expect(JSON.parse(raw[2]!).prev).toBe(sha(raw[1]!))
      expect(PermissionAudit.verify().ok).toBe(true)
    })
  })

  test("legacy lines before chained lines verify; a legacy line after a chained one breaks", () => {
    logged(() => {
      const legacy = (n: number) => JSON.stringify({ time: 1, kind: "decision", n }) + "\n"
      fs.mkdirSync(path.dirname(PermissionAudit.file()), { recursive: true })
      fs.writeFileSync(PermissionAudit.file(), legacy(0) + legacy(1))
      PermissionAudit.write({ kind: "decision", n: 2 })
      const ok = PermissionAudit.verify()
      expect(ok).toMatchObject({ ok: true, lines: 3, legacy: 2 })

      fs.appendFileSync(PermissionAudit.file(), legacy(3))
      const broken = PermissionAudit.verify()
      expect(broken.ok).toBe(false)
      expect(broken.broken).toMatchObject({ file: PermissionAudit.file(), line: 4 })
      expect(broken.broken?.reason).toContain("legacy line after a chained line")
    })
  })
})
