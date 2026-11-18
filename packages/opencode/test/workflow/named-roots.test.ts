import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { lookupNamedWorkflow, namedWorkflowRoots } from "@/tool/workflow"
import { tmpdir } from "../fixture/fixture"

const script = (name: string) =>
  [`export const meta = { name: "${name}", description: "probe" }`, `return "${name}"`].join("\n")

async function save(dir: string, name: string) {
  const wf = path.join(dir, ".hordecode", "workflows")
  await fs.mkdir(wf, { recursive: true })
  await fs.writeFile(path.join(wf, `${name}.js`), script(name))
}

test("non-git: lookup starts and stops at the instance directory", async () => {
  await using tmp = await tmpdir({ trust: true })
  await save(tmp.path, "root-wf")
  const roots = namedWorkflowRoots(undefined, { worktree: "/", directory: tmp.path })
  expect(roots).toEqual({ start: tmp.path, stop: tmp.path })
  expect(await lookupNamedWorkflow("root-wf", roots.start, roots.stop)).toBe(script("root-wf"))
})

test("git: an explicit workspace still finds a workflow saved at the worktree root", async () => {
  await using tmp = await tmpdir({ trust: true })
  await save(tmp.path, "root-wf")
  const sub = path.join(tmp.path, "sub")
  await fs.mkdir(sub, { recursive: true })
  const roots = namedWorkflowRoots(sub, { worktree: tmp.path, directory: sub })
  expect(roots).toEqual({ start: sub, stop: tmp.path })
  expect(await lookupNamedWorkflow("root-wf", roots.start, roots.stop)).toBe(script("root-wf"))
})

test("the tool wires the lookup through the anchored roots", async () => {
  const src = await Bun.file(path.join(import.meta.dir, "../../src/tool/workflow.ts")).text()
  expect(src).toContain("const roots = namedWorkflowRoots(input.workspace, instance)")
  expect(src).toContain("lookupNamedWorkflow(input.name!, roots.start, roots.stop)")
})
