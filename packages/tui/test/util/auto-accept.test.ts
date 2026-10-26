import { expect, test } from "bun:test"
import { autoAcceptKey, restoredMode, saveMode } from "../../src/util/auto-accept"

const memory = () => {
  const data = new Map<string, unknown>()
  return { data, get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, set: (key: string, value: unknown) => void data.set(key, value) }
}

test("the toggle is remembered per project directory", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "auto")
  expect(restoredMode(kv, "/work/a", false)).toBe("auto")
  expect(restoredMode(kv, "/work/b", false)).toBe("normal")
  expect(kv.data.get(autoAcceptKey("/work/a"))).toBe(true)
})

test("turning it off clears the stored value and a restart starts normal", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "auto")
  saveMode(kv, "/work/a", "normal")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})

test("a project that never enabled it stores nothing", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "normal")
  expect(kv.data.size).toBe(0)
})

test("the launch flag wins and nothing stored means normal", () => {
  const kv = memory()
  expect(restoredMode(kv, "/work/a", true)).toBe("auto")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})
