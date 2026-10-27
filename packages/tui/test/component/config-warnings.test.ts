import { describe, expect, test } from "bun:test"
import { unknownKeysMessage } from "../../src/component/config-warnings"

describe("unknownKeysMessage", () => {
  test("returns nothing when no keys are unknown", () => {
    expect(unknownKeysMessage([])).toBeUndefined()
  })

  test("names a single key with its suggestion", () => {
    expect(unknownKeysMessage([{ path: "a.b", suggestion: "a.c" }])).toBe(
      'Config: unknown key "a.b" (did you mean "a.c"?)',
    )
  })

  test("omits the suggestion when there is none", () => {
    expect(unknownKeysMessage([{ path: "zzz" }])).toBe('Config: unknown key "zzz"')
  })

  test("lists up to three keys and elides the rest", () => {
    const keys = [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }]
    expect(unknownKeysMessage(keys)).toBe("Config: 4 unknown keys: a, b, c, ... Run horde debug config for details.")
  })

  test("lists every key when there are three or fewer", () => {
    expect(unknownKeysMessage([{ path: "a" }, { path: "b" }])).toBe(
      "Config: 2 unknown keys: a, b. Run horde debug config for details.",
    )
  })
})
