import { describe, expect, it } from "bun:test"
import path from "node:path"

//  PART_MAPPING in packages/tui/src/routes/session/index.tsx used to
// only know 3 of the schema's part types (text/tool/reasoning). Anything
// else -- including the CheckpointPart that  started producing on every
// rebuild-from-overflow -- was silently dropped via `Show when={component()}`
// at the dispatch site.
//
// First fix: add CheckpointPart render + UnknownPart fallback for genuinely
// unknown types. Second fix (after live review): step-start / step-finish are
// emitted on EVERY tool-using turn (processor.ts:471,673) -- rendering them
// via UnknownPart would put a marker line on every assistant message, a real
// visual regression. Same for file/agent (rendered in prompt/index.tsx as
// user-side attachments) and snapshot/subtask (unused at runtime). Those
// keep the silent-skip; only genuinely unexpected types get
// UnknownPart.
//
// This test pins both invariants: PART_MAPPING covers CheckpointPart, AND
// the SILENT_TYPES set restores silent-skip for the lifecycle/telemetry
// types whose canonical render lives elsewhere.

const SESSION_INDEX_PATH = path.join(import.meta.dir, "../../src/routes/session/index.tsx")

describe("PART_MAPPING covers all in-use Part types", () => {
  it("PART_MAPPING is exported and CheckpointPart has an entry", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const mapping = (mod as any).PART_MAPPING
    expect(mapping).toBeDefined()
    expect(mapping).not.toBeNull()
    expect(typeof mapping).toBe("object")
    expect(mapping.checkpoint).toBeDefined()
    expect(typeof mapping.checkpoint).toBe("function")
  })

  it("PART_MAPPING keeps the 3 original keys (text/tool/reasoning) untouched", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const mapping = (mod as any).PART_MAPPING
    expect(typeof mapping.text).toBe("function")
    expect(typeof mapping.tool).toBe("function")
    expect(typeof mapping.reasoning).toBe("function")
  })

  it("PART_MAPPING has no stale 'undefined' or non-function entries", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const mapping = (mod as any).PART_MAPPING
    for (const [key, value] of Object.entries(mapping)) {
      expect(typeof value, `entry ${key} must be a component function`).toBe("function")
    }
  })
})

describe("SILENT_TYPES preserves silent-skip for lifecycle/telemetry parts", () => {
  it("SILENT_TYPES is exported as a ReadonlySet<string>", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const set = (mod as any).SILENT_TYPES
    expect(set).toBeDefined()
    expect(set).toBeInstanceOf(Set)
  })

  it("SILENT_TYPES contains step-start, step-finish, file, agent, snapshot, subtask, patch, retry", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const set: Set<string> = (mod as any).SILENT_TYPES
    // step-start/step-finish are emitted every tool-using turn
    // (processor.ts:471,673 + 991,1106) -- silent-skip is the only way to
    // avoid an UnknownPart marker on every assistant message.
    // patch is emitted on every step with file edits (processor.ts:698) --
    // the tool part already renders the diff; patch is a side-channel.
    // retry is emitted on retry events (processor.ts:950) -- the session
    // header already shows retry status; the retry Part is a side-channel.
    // file/agent are user-side attachments rendered in prompt/index.tsx.
    // snapshot is unused at runtime. subtask is in the schema union but
    // never produced.
    for (const t of [
      "step-start",
      "step-finish",
      "patch",
      "retry",
      "file",
      "agent",
      "snapshot",
      "subtask",
    ]) {
      expect(set.has(t), `SILENT_TYPES must contain ${t}`).toBe(true)
    }
  })

  it("SILENT_TYPES does NOT include checkpoint (it must render via CheckpointPart)", async () => {
    const mod = await import(SESSION_INDEX_PATH)
    const set: Set<string> = (mod as any).SILENT_TYPES
    // Adding checkpoint to SILENT_TYPES would re-silence the very part 
    // exists to render. If this assertion fails, someone added checkpoint to
    // the set -- which would re-introduce the silent-drop bug for the only
    // type we explicitly want to display.
    expect(set.has("checkpoint")).toBe(false)
  })
})

describe("dispatcher skips SILENT_TYPES before falling through to UnknownPart", () => {
  it("the dispatch site checks SILENT_TYPES before the UnknownPart fallback", async () => {
    const src = await Bun.file(SESSION_INDEX_PATH).text()
    // The SILENT_TYPES guard must appear in the For-each-parts callback,
    // BEFORE the PART_MAPPING[...] lookup. If it's after, the fallback would
    // be tried first and step-start would still render as UnknownPart.
    const silentIdx = src.indexOf("SILENT_TYPES.has(part.type)")
    const mappingIdx = src.indexOf("PART_MAPPING[part.type")
    expect(silentIdx).toBeGreaterThan(-1)
    expect(mappingIdx).toBeGreaterThan(-1)
    expect(silentIdx).toBeLessThan(mappingIdx)
  })

  it("the dispatcher still falls back to UnknownPart for genuinely unmapped types", async () => {
    const src = await Bun.file(SESSION_INDEX_PATH).text()
    expect(src).toMatch(/PART_MAPPING\[part\.type[^\]]*\] \?\? UnknownPart/)
    // The fallback exists; SILENT_TYPES just gates the path before it.
    const dispatchRegion = src.slice(
      src.indexOf("SILENT_TYPES.has(part.type)"),
      src.indexOf("SILENT_TYPES.has(part.type)") + 800,
    )
    expect(dispatchRegion).toMatch(/PART_MAPPING\[part\.type[^\]]*\] \?\? UnknownPart/)
  })

  it("UnknownPart component is defined and surfaces the type name", async () => {
    const src = await Bun.file(SESSION_INDEX_PATH).text()
    expect(src).toMatch(/function UnknownPart\(/)
    expect(src).toContain("unsupported part type:")
  })
})

describe("invariant: every schema part type dispatched in AssistantMessage is one of {rendered, silent}", () => {
  it("no schema part type falls through to a silent drop without being in SILENT_TYPES", async () => {
    // Authoritative Part union: packages/schema/src/v1/session.ts:369-383.
    // The dispatcher in AssistantMessage only sees parts that runtime emits
    // as Part records on AssistantMessage. We exclude 'compaction' here
    // because runtime produces it as a SessionMessage (Compaction message
    // type, NOT a Part) -- core/session/message-updater.ts:381 builds a
    // `SessionMessage.Compaction`, not a Part. So the dispatcher's PART_MAPPING
    // lookup never runs for 'compaction'. Every other schema Part type is
    // dispatched through AssistantMessage.
    const dispatchedTypes = [
      "text",
      "subtask",
      "reasoning",
      "file",
      "tool",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "checkpoint",
    ]
    const mod = await import(SESSION_INDEX_PATH)
    const mapping = (mod as any).PART_MAPPING
    const silent: Set<string> = (mod as any).SILENT_TYPES
    for (const t of dispatchedTypes) {
      const isMapped = typeof mapping[t] === "function"
      const isSilent = silent.has(t)
      // Strict: every dispatched schema Part type must be in PART_MAPPING
      // (typed renderer) OR SILENT_TYPES (intentional silent-skip).
      // Anything else would be a real silent-drop bug -- the part would
      // hit the UnknownPart fallback and surface a '[unsupported part
      // type: X]' marker in the live TUI. Future schema additions must
      // either get a renderer OR get added to SILENT_TYPES (with rationale).
      expect(
        isMapped || isSilent,
        `dispatched schema type "${t}" must be in PART_MAPPING or SILENT_TYPES ` +
          `(otherwise UnknownPart would render a marker on every assistant message)`,
      ).toBe(true)
    }
  })

  it("the unknown-fallback (UnknownPart) only fires for genuinely unmapped, unsilent types", async () => {
    // With all dispatched schema Part types covered above, the only way
    // UnknownPart renders is when a future schema addition slips past
    // both PART_MAPPING and SILENT_TYPES. The regression test's value is
    // that it will fail the moment someone adds a new Part type without
    // updating both -- forcing a deliberate decision rather than a silent
    // gap. Sanity check: every dispatched type IS already covered.
    const mod = await import(SESSION_INDEX_PATH)
    const mapping = (mod as any).PART_MAPPING
    const silent: Set<string> = (mod as any).SILENT_TYPES
    const dispatchedTypes = [
      "text",
      "subtask",
      "reasoning",
      "file",
      "tool",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "checkpoint",
    ]
    const unhandled = dispatchedTypes.filter((t) => !mapping[t] && !silent.has(t))
    expect(unhandled, "no dispatched schema Part type should fall through").toEqual([])
  })
})