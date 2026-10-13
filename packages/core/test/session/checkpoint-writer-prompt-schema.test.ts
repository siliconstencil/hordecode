import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  validateSnapshot,
  validateLearning,
} from "@opencode-ai/core/session/checkpoint-validator"

// Checkpoint writer the checkpoint-writer prompt MUST instruct the validator-enforced
// schema, otherwise every faithful checkpoint write fails validation and can
// exhaust the retry budget. This test fails while the prompt documents the
// old numbered-section format and passes once it documents the Topic: + ### schema.

const PROMPT = readFileSync(
  resolve(import.meta.dir, "../../../agent/src/prompt/checkpoint-writer.txt"),
  "utf-8",
)

const REQUIRED_SUBS = [
  "### Execution context",
  "### Live resources",
  "### Session metadata",
  "### Discovered",
  "### Dead ends",
]

describe("Checkpoint-writer prompt matches checkpoint-validator schema", () => {
  it("prompt documents the Topic: first line and the 5 required ### sub-sections in order", () => {
    // Topic: must be documented as the required first line (no leading "#").
    expect(PROMPT).toMatch(/\bTopic:/)
    expect(PROMPT).toMatch(/first non-blank line/i)
    const positions = REQUIRED_SUBS.map((s) => PROMPT.indexOf(s))
    expect(positions.every((p) => p !== -1)).toBe(true)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it("a checkpoint following the prompt's documented schema passes the validator", () => {
    const body = `Topic: checkpoint-writer prompt and validator aligned

### Execution context
User asked to align the checkpoint-writer prompt with the validator. Next: report the fix.
> "The checkpoint-writer prompt and its validator ask for different formats; verify first, then align them"

### Live resources
branch: checkpoint-fix

### Session metadata
session: ses_example
model: x
agent-mode: harness

### Discovered
- checkpoint-writer prompt and validator disagreed (upstream)
  Why: prompt documented §1-§11 while validator required Topic + ### subs
  How to apply: keep the prompt in lockstep with checkpoint-validator.ts

### Dead ends
- (none)
`
    const violations = [
      ...validateSnapshot(body, "checkpoint.md"),
      ...validateLearning(body, "checkpoint.md", new Set()),
    ]
    const errors = violations.filter((v) => v.severity === "error")
    expect(errors).toEqual([])
  })
})
