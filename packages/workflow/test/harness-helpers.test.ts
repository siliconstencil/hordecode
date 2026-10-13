import { describe, it, expect } from "bun:test"
import { parseArgs, slugifyFeatureName, classifyType, topoSort } from "../src/builtin/harness-helpers"

describe("harness.js pure helpers", () => {
  describe("parseArgs", () => {
    it("accepts an object input and returns {args, task}", () => {
      const result = parseArgs({ task: "do the thing", type: "feature" })
      expect(result).toEqual({ args: { task: "do the thing", type: "feature" }, task: "do the thing" })
    })

    it("accepts a JSON string input and decodes it", () => {
      const result = parseArgs(JSON.stringify({ task: "decode me", skip_brainstorm: true }))
      expect(result.task).toBe("decode me")
      expect((result as any).args.skip_brainstorm).toBe(true)
    })

    it("treats an unparseable string as a bare task string", () => {
      const result = parseArgs("not json at all")
      expect(result).toEqual({ args: { task: "not json at all" }, task: "not json at all" })
    })

    it("coerces a JSON value that is not an object (e.g. number) to a bare task", () => {
      const result = parseArgs("42")
      expect(result.task).toBe("42")
    })

    it("returns no-task error when args.task is missing", () => {
      const result = parseArgs({ type: "feature" })
      expect(result).toEqual({ error: "no-task", message: "Pass args.task = '<request>'." })
    })

    it("returns no-task error when args is empty object", () => {
      const result = parseArgs({})
      expect(result).toEqual({ error: "no-task", message: "Pass args.task = '<request>'." })
    })

    it("returns no-task error when args.task is not a string", () => {
      const result = parseArgs({ task: 123 })
      expect(result).toEqual({ error: "no-task", message: "Pass args.task = '<request>'." })
    })

    it("returns no-task error when args is null", () => {
      const result = parseArgs(null)
      expect(result).toEqual({ error: "no-task", message: "Pass args.task = '<request>'." })
    })

    it("returns no-task error when args is undefined", () => {
      const result = parseArgs(undefined)
      expect(result).toEqual({ error: "no-task", message: "Pass args.task = '<request>'." })
    })
  })

  describe("slugifyFeatureName", () => {
    it("prefers an explicit feature_name over the task", () => {
      expect(slugifyFeatureName("explicit-name", "task text")).toBe("explicit-name")
    })

    it("lowercases and replaces non-alphanumeric runs with a single dash", () => {
      expect(slugifyFeatureName("", "Add User Auth Flow!")).toBe("add-user-auth-flow")
    })

    it("strips leading and trailing dashes", () => {
      expect(slugifyFeatureName("", "!!!hello world!!!")).toBe("hello-world")
    })

    it("caps length at 60 characters and trims trailing dashes from the cut", () => {
      // 80-char source that gets cut to 60 mid-segment; trailing-dash trim
      // is the second replace(/-+$/, "") so a cut landing on a separator
      // doesn't leave an ugly trailing dash.
      const long = "a".repeat(30) + " " + "b".repeat(30) + " " + "c".repeat(30)
      const result = slugifyFeatureName("", long)
      expect(result.length).toBeLessThanOrEqual(60)
      expect(result.endsWith("-")).toBe(false)
    })

    it("falls back to 'harness-run' when source is empty", () => {
      expect(slugifyFeatureName("", "")).toBe("harness-run")
    })

    it("falls back to 'harness-run' when source slugifies to empty", () => {
      expect(slugifyFeatureName("", "!@#$%^&*()")).toBe("harness-run")
    })

    it("treats an empty feature_name the same as no override", () => {
      expect(slugifyFeatureName("", "fall back to task")).toBe("fall-back-to-task")
    })
  })

  describe("classifyType", () => {
    it("honors an explicit valid argType", () => {
      expect(classifyType("refactor", "anything goes here")).toBe("refactor")
      expect(classifyType("bugfix", "")).toBe("bugfix")
      expect(classifyType("feedback", "")).toBe("feedback")
    })

    it("ignores an invalid argType and falls through to the heuristic", () => {
      expect(classifyType("invalid", "fix the login bug")).toBe("bugfix")
    })

    it("classifies PR-feedback phrasing as feedback", () => {
      expect(classifyType("", "address the review feedback on this PR")).toBe("feedback")
      expect(classifyType("", "PR review comment needs follow up")).toBe("feedback")
    })

    it("classifies bug-keyword phrasing as bugfix", () => {
      expect(classifyType("", "fix the broken login")).toBe("bugfix")
      expect(classifyType("", "there's a regression in the search")).toBe("bugfix")
      // Note: "crashes" / "failing" plural/ing forms are NOT covered by
      // the existing regex (it matches \bcrash\b and \bfails?\b, not the
      // -s inflected form or -ing participle). Pinned as known-shape
      // misses; a follow-up could broaden the heuristic, but the design
      // agent re-judges with full context anyway so the conservative
      // regex is intentional.
      expect(classifyType("", "this crash on startup")).toBe("bugfix")
      expect(classifyType("", "the test fails")).toBe("bugfix")
    })

    it("classifies generic phrasing as feature", () => {
      expect(classifyType("", "add user authentication")).toBe("feature")
      expect(classifyType("", "implement a new dashboard")).toBe("feature")
    })

    it("is case-insensitive (lowercases the task before matching)", () => {
      expect(classifyType("", "FIX THE BUG")).toBe("bugfix")
      expect(classifyType("", "Add User Auth")).toBe("feature")
    })

    it("prefers feedback over bugfix when both regexes match (PR feedback + bug word)", () => {
      // "PR review feedback on broken login" matches the feedback regex
      // first; feedback is checked before bugfix in the original logic.
      expect(classifyType("", "PR review feedback on broken login")).toBe("feedback")
    })
  })

  describe("topoSort", () => {
    it("returns a single batch when there are no dependencies", () => {
      const tasks = [
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ]
      const result = topoSort(tasks)
      expect(result).toEqual({ batches: [["a", "b", "c"]] })
    })

    it("orders a linear chain across multiple batches", () => {
      const tasks = [
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]
      const result = topoSort(tasks)
      expect(result).toEqual({ batches: [["a"], ["b"], ["c"]] })
    })

    it("groups independent tasks into the same batch", () => {
      const tasks = [
        { id: "a" },
        { id: "b" },
        { id: "c", dependsOn: ["a", "b"] },
      ]
      const result = topoSort(tasks)
      expect(result).toEqual({ batches: [["a", "b"], ["c"]] })
    })

    it("ignores dependencies that point to unknown task ids", () => {
      const tasks = [
        { id: "a" },
        { id: "b", dependsOn: ["ghost"] },
      ]
      const result = topoSort(tasks)
      expect(result).toEqual({ batches: [["a", "b"]] })
    })

    it("returns design-cycle error when a cycle is present", () => {
      const tasks = [
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]
      const result = topoSort(tasks)
      if (!("batches" in result)) {
        expect(result.error).toBe("design-cycle")
        expect(Array.isArray(result.cycleNodes)).toBe(true)
      } else {
        throw new Error("expected design-cycle error, got batches")
      }
    })

    it("returns an empty batches array for an empty input", () => {
      const result = topoSort([])
      expect(result).toEqual({ batches: [] })
    })

    it("handles a diamond dependency", () => {
      const tasks = [
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a"] },
        { id: "d", dependsOn: ["b", "c"] },
      ]
      const result = topoSort(tasks)
      if ("batches" in result) {
        expect(result.batches[0]).toEqual(["a"])
        expect(result.batches[1]?.sort()).toEqual(["b", "c"])
        expect(result.batches[2]).toEqual(["d"])
      } else {
        throw new Error("expected batches, got cycle error")
      }
    })
  })
})
