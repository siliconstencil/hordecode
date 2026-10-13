/**
 * checkpoint-templates behavioral tests.
 *
 * Closes the checkpoint-templates gap in the checkpoint scenario coverage.
 *
 * Schema divergence from upstream: v0.1.11's checkpoint-templates.test.ts
 * asserts the v8 schema with "Design decisions" + "Open notes"
 * numbered headings, plus a NOTES_TEMPLATE mentioning "## [turn N - ...]".
 * Fork uses a validator-enforced schema: `Topic: <summary>`
 * first line + 5 `###` sub-sections (Execution context, Live resources,
 * Session metadata, Discovered, Dead ends) -- per checkpoint-validator.ts
 * SNAPSHOT_REQUIRED_SECTIONS + LEARNING_REQUIRED_SECTIONS. The CHECKPOINT_TEMPLATE,
 * MEMORY_TEMPLATE, NOTES_TEMPLATE, and CHECKPOINT_SECTION_BUDGETS exist in fork at
 * packages/core/src/session/checkpoint-templates.ts; what this test pins is
 * that the templates match the validator's required-section list AND that
 * composeWriterPrompt substitutes every section budget into the rendered
 * output (all section budgets injected into the rendered output).
 *
 * Fork source: packages/core/src/session/checkpoint-templates.ts
 * Fork consumer: packages/core/src/session/checkpoint.ts:379
 *                (composeWriterPrompt -> test-only re-export at :1981)
 */
import { describe, expect, test } from "bun:test"
import {
  CHECKPOINT_TEMPLATE,
  MEMORY_TEMPLATE,
  CHECKPOINT_SECTION_BUDGETS,
  MEMORY_SECTION_BUDGETS,
  NOTES_TEMPLATE,
} from "../../src/session/checkpoint-templates"
import { SNAPSHOT_REQUIRED_SECTIONS, LEARNING_REQUIRED_SECTIONS } from "../../src/session/checkpoint-validator"
// composeWriterPrompt lives in checkpoint.ts; the file re-exports it for tests
// as composeWriterPromptForTest (line 1981, comment: "Test-only re-export so
// test code can call composeWriterPrompt without ...").
import { composeWriterPromptForTest } from "../../src/session/checkpoint"

describe("checkpoint-templates (fork port + schema-adapted)", () => {
  describe("CHECKPOINT_TEMPLATE matches validator schema", () => {
    test("documents the required `Topic:` first-line convention", () => {
      expect(CHECKPOINT_TEMPLATE).toMatch(/^Topic:/m)
      // Validator rejects `# Checkpoint #N` as the first line; the template
      // must not model that anti-pattern.
      expect(CHECKPOINT_TEMPLATE).not.toMatch(/^# Checkpoint #\d+/m)
    })

    test.each([...SNAPSHOT_REQUIRED_SECTIONS])("contains snapshot section %s", (section: string) => {
      expect(CHECKPOINT_TEMPLATE).toContain(section)
    })

    test.each([...LEARNING_REQUIRED_SECTIONS])("contains learning section %s", (section: string) => {
      expect(CHECKPOINT_TEMPLATE).toContain(section)
    })

    test("snapshot sections appear before learning sections (validator subsection-out-of-order)", () => {
      const firstSnapshot = Math.min(
        ...SNAPSHOT_REQUIRED_SECTIONS.map((s) => CHECKPOINT_TEMPLATE.indexOf(s)).filter((i) => i >= 0),
      )
      const firstLearning = Math.min(
        ...LEARNING_REQUIRED_SECTIONS.map((s) => CHECKPOINT_TEMPLATE.indexOf(s)).filter((i) => i >= 0),
      )
      expect(firstSnapshot).toBeGreaterThanOrEqual(0)
      expect(firstLearning).toBeGreaterThan(firstSnapshot)
    })
  })

  describe("MEMORY_TEMPLATE matches MEMORY_SECTION_BUDGETS keys", () => {
    test.each(Object.keys(MEMORY_SECTION_BUDGETS))("contains memory section %s", (section: string) => {
      expect(MEMORY_TEMPLATE).toContain(`## ${section}`)
    })
  })

  describe("CHECKPOINT_SECTION_BUDGETS covers every validator-required sub-section", () => {
    test.each([...SNAPSHOT_REQUIRED_SECTIONS, ...LEARNING_REQUIRED_SECTIONS])(
      "has a budget entry for %s",
      (section: string) => {
        // Budget keys drop the leading `### ` to a plain label.
        const label = section.replace(/^### /, "")
        expect(CHECKPOINT_SECTION_BUDGETS[label]).toBeTypeOf("number")
        expect(CHECKPOINT_SECTION_BUDGETS[label]).toBeGreaterThan(0)
      },
    )

    test("total section budget is bounded (well under the 40K tail max)", () => {
      const total = Object.values(CHECKPOINT_SECTION_BUDGETS).reduce((a, b) => a + b, 0)
      // The 2026-08-27 audit noted ~6.6K; guard against accidental unbounded growth.
      expect(total).toBeLessThan(20_000)
    })
  })

  describe("NOTES_TEMPLATE (dedupe hint)", () => {
    test("exists with the header", () => {
      expect(NOTES_TEMPLATE).toBeDefined()
      expect(NOTES_TEMPLATE).toContain("# Session notes")
    })

    test("documents the turn-by-turn entry format with ISO-8601 timestamp", () => {
      expect(NOTES_TEMPLATE).toContain("turn N")
      expect(NOTES_TEMPLATE).toContain("YYYY-MM-DDTHH:MM:SSZ")
    })

    test("includes the dedupe hint", () => {
      expect(NOTES_TEMPLATE).toMatch(/scan existing entries/i)
    })
  })

  describe("composeWriterPrompt renders section budgets", () => {
    test("substitutes every CHECKPOINT_SECTION_BUDGETS key+value into the prompt", () => {
      const out = composeWriterPromptForTest({
        checkpointFile: "/tmp/p7-95-c-templates/checkpoint.md",
        memoryFile: "/tmp/p7-95-c-templates/memory.md",
        taskMemDir: "/tmp/p7-95-c-templates/tasks",
        notesFile: "/tmp/p7-95-c-templates/notes.md",
        rangeDesc: "test range",
        progressDiff: "",
      })

      for (const [section, budget] of Object.entries(CHECKPOINT_SECTION_BUDGETS)) {
        // The substitution convention is `<label>: <budget>` somewhere in the prompt
        expect(out).toContain(`${section}: ${budget}`)
      }
    })
  })
})
