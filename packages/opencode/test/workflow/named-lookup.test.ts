import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { lookupNamedWorkflow } from "@/tool/workflow"
import { BuiltinWorkflow } from "@opencode-ai/workflow/builtin"
import { tmpdir } from "../fixture/fixture"

const HELLO = [`export const meta = { name: "hello", description: "saved probe" }`, `return "hello"`].join("\n")

// Lookup order: built-in first, then .hordecode/workflows/<name>.js, else null.
test("named workflow lookup: built-in wins, then saved file, then not found", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  await fs.mkdir(path.join(root, ".hordecode", "workflows"), { recursive: true })
  await fs.writeFile(path.join(root, ".hordecode", "workflows", "hello.js"), HELLO)
  await fs.writeFile(path.join(root, ".hordecode", "workflows", "deep-research.js"), "SHADOW")

  expect(await lookupNamedWorkflow("hello", root, root)).toBe(HELLO)
  expect(await lookupNamedWorkflow("deep-research", root, root)).toBe(BuiltinWorkflow.get("deep-research")!.script)
  expect(await lookupNamedWorkflow("missing-wf", root, root)).toBeNull()
})
