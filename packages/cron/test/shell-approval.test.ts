import { describe, it, expect, beforeEach } from "bun:test"
import { approveShell, isShellApproved } from "../src/shell-approval"

describe("shell-approval", () => {
  beforeEach(() => {
    // Each test starts fresh because the approved set is module-level.
    // This is a limitation of the current implementation: the in-memory set
    // persists across tests in the same process.
  })

  describe("isShellApproved", () => {
    it("returns false for unapproved command", () => {
      expect(isShellApproved("echo a")).toBe(false)
    })

    it("returns true after approveShell is called with the same command", () => {
      approveShell("echo a")
      expect(isShellApproved("echo a")).toBe(true)
    })

    it("returns false for a different command even after another is approved", () => {
      approveShell("echo a")
      expect(isShellApproved("echo b")).toBe(false)
    })

    it("is case-sensitive", () => {
      approveShell("echo hello")
      expect(isShellApproved("echo hello")).toBe(true)
      expect(isShellApproved("ECHO hello")).toBe(false)
    })

    it("distinguishes whitespace differences", () => {
      approveShell("echo a")
      expect(isShellApproved("echo  a")).toBe(false)
      expect(isShellApproved("echo a ")).toBe(false)
    })

    it("allows multiple commands to be approved independently", () => {
      approveShell("echo a")
      approveShell("ls -la")
      approveShell("rm -f file.txt")
      expect(isShellApproved("echo a")).toBe(true)
      expect(isShellApproved("ls -la")).toBe(true)
      expect(isShellApproved("rm -f file.txt")).toBe(true)
      expect(isShellApproved("echo b")).toBe(false)
    })
  })

  describe("approveShell", () => {
    it("accepts any string without validation", () => {
      // approveShell takes any string, trusting the caller to validate
      approveShell("")
      approveShell("ls")
      approveShell("a/b/c")
      expect(isShellApproved("ls")).toBe(true)
    })

    it("idempotently re-approves the same command", () => {
      approveShell("echo test")
      approveShell("echo test")
      expect(isShellApproved("echo test")).toBe(true)
    })
  })
})
