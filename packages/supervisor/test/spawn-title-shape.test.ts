import { describe, expect, it } from "bun:test"
import path from "node:path"

// T-LABEL: the child session title is the only carrier of the agent name for
// the TUI footer label (packages/tui/src/routes/session/subagent-footer.tsx:36,
// `title.match(/@(\w+) subagent/)`). opencode produces that shape at
// tool/task.ts:160 as `description + " (@" + agent.name + " subagent)"`; fork
// produced `agentType + ": " + task` instead, so the footer fell back to the
// literal "Subagent" in the child-session view.
//
// The title is built inline at the two session.create sites (spawnPeer /
// spawnSubagent), so this locks the producer shape at source level. The
// behavioural half lives in the TUI footer render test, which runs the real
// regex over a title in this exact shape.

const source = await Bun.file(path.join(import.meta.dir, "../src/spawn.ts")).text()
const footer = await Bun.file(
  path.join(import.meta.dir, "../../tui/src/routes/session/subagent-footer.tsx"),
).text()

describe("child session title shape (opencode tool/task.ts:160)", () => {
  it("uses the agent marker at both session.create title sites", () => {
    const titles = source.match(/^\s+title: [^\n]*/gm) ?? []
    expect(titles.length).toBe(2)
    for (const title of titles) expect(title.trim()).toBe("title: childSessionTitle(input),")
  })

  it("builds the title from the description (not a task prefix) with the agent marker", () => {
    expect(source).toContain("`${input.description || input.agentType} (@${input.agentType} subagent)`")
    expect(source).not.toContain("input.task.slice(0, 40)")
  })

  it("no longer produces the `agentType: task` shape the footer regex misses", () => {
    expect(source).not.toContain("${input.agentType}: ")
  })

  it("keeps the registry fields untouched (entry-based labelling in agentID views)", () => {
    expect(source).toContain("agent: input.agentType")
    expect(source).toContain("description: input.description ?? input.agentType")
  })

  it("cites the opencode reference next to both title sites", () => {
    expect(source.match(/opencode tool\/task\.ts:160/g)?.length).toBe(2)
  })
})

describe("footer consumer contract", () => {
  it("reads the marker from the title with opencode's own regex", () => {
    expect(footer).toContain("title.match(/@(\\w+) subagent/)")
  })

  it("matches \\w+ agent names and misses hyphenated ones (intended, unchanged)", () => {
    // opencode's regex is kept verbatim: `\w` excludes hyphens, so an agent such
    // as dev-assistant still falls back to "Subagent". Recorded, not changed.
    expect("task (@general subagent)".match(/@(\w+) subagent/)?.[1]).toBe("general")
    expect("task (@dev-assistant subagent)".match(/@(\w+) subagent/)).toBeNull()
  })
})
