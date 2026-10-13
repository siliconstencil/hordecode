import { describe, it, expect } from "bun:test"
import { assertSegment, assertInsideRoot, WRITE_SCOPES } from "../src/paths"

describe("path-guard", () => {
  describe("assertSegment", () => {
    it("throws for empty string", () => {
      expect(() => assertSegment("", "test")).toThrow()
    })

    it("throws for dot", () => {
      expect(() => assertSegment(".", "test")).toThrow()
    })

    it("throws for double-dot", () => {
      expect(() => assertSegment("..", "test")).toThrow()
    })

    it("throws for path with forward slash", () => {
      expect(() => assertSegment("a/b", "test")).toThrow()
    })

    it("throws for path with backslash", () => {
      expect(() => assertSegment("a\\b", "test")).toThrow()
    })

    it("throws for absolute path", () => {
      expect(() => assertSegment("/abs", "test")).toThrow()
    })

    it("throws for null byte", () => {
      expect(() => assertSegment("x\u0000y", "test")).toThrow()
    })

    it("does not throw for valid segment", () => {
      expect(() => assertSegment("proj-123", "test")).not.toThrow()
    })

    it("does not throw for alphanumeric segment", () => {
      expect(() => assertSegment("concept", "test")).not.toThrow()
    })

    it("includes label in error message", () => {
      expect(() => assertSegment("", "custom-label")).toThrow(/custom-label/)
    })
  })

  describe("assertInsideRoot", () => {
    it("accepts a normal path inside root", () => {
      expect(() => assertInsideRoot("/r", "/r/a/b.md")).not.toThrow()
    })

    it("accepts nested paths inside root", () => {
      expect(() => assertInsideRoot("/r", "/r/x/y/z.md")).not.toThrow()
    })

    it("throws when path escapes via parent traversal", () => {
      expect(() => assertInsideRoot("/r", "/r/../x.md")).toThrow(/escapes/)
    })

    it("throws when path is outside root", () => {
      expect(() => assertInsideRoot("/r", "/x/y.md")).toThrow(/escapes/)
    })

    it("throws when target is the root itself", () => {
      expect(() => assertInsideRoot("/r", "/r")).toThrow(/escapes/)
    })

    it("rejects deeply escaped paths", () => {
      expect(() => assertInsideRoot("/r", "/r/../../escape.md")).toThrow(/escapes/)
    })
  })

  describe("WRITE_SCOPES", () => {
    it("equals expected scope list", () => {
      expect(WRITE_SCOPES).toEqual(["global", "projects", "sessions", "cc"])
    })

    it("is a read-only const array", () => {
      expect(Array.isArray(WRITE_SCOPES)).toBe(true)
    })

    it("has correct length", () => {
      expect(WRITE_SCOPES.length).toBe(4)
    })

    it("includes all required scopes", () => {
      expect(WRITE_SCOPES).toContain("global")
      expect(WRITE_SCOPES).toContain("projects")
      expect(WRITE_SCOPES).toContain("sessions")
      expect(WRITE_SCOPES).toContain("cc")
    })
  })
})
