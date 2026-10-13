import { describe, expect, test } from "bun:test"
import type { z } from "zod"
import { TuiEvent } from "../src/cli/cmd/tui/event"

type InstructionsLoadedPayload = z.output<typeof TuiEvent.InstructionsLoaded.properties>

describe("TuiEvent", () => {
  test("InstructionsLoaded is a typed BusEvent definition", () => {
    expect(TuiEvent.InstructionsLoaded.type).toBe("tui.instructions.loaded")

    // @ts-expect-error -- InstructionsLoaded payload is { files: string[] }, not { files: number }
    const invalid: InstructionsLoadedPayload = { files: 42 }
    expect(invalid).toBeDefined()

    // @ts-expect-error -- InstructionsLoaded type literal is "tui.instructions.loaded", not "tui.toast.show"
    const wrongType: typeof TuiEvent.InstructionsLoaded.type = "tui.toast.show"
    expect(wrongType).toBeTypeOf("string")

    const valid: InstructionsLoadedPayload = { files: ["CLAUDE.md"] }
    expect(valid.files).toEqual(["CLAUDE.md"])
  })
})
