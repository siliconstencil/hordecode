import { describe, expect, test } from "bun:test"
import { toolDisplay } from "../../src/routes/session/index"

// hashline_edit carries filePath and metadata.diff like edit, so the transcript shows its diff.
describe("hashline tool display", () => {
  test("hashline tools use the read and edit views", () => {
    expect(toolDisplay("hashline_read")).toBe("read")
    expect(toolDisplay("hashline_edit")).toBe("edit")
    expect(toolDisplay("edit")).toBe("edit")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })
})
