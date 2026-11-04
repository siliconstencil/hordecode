import { expect, test } from "bun:test"
import { autoAcceptKey, carefulKey, restoredMode, saveMode } from "../../src/util/auto-accept"

const memory = () => {
  const data = new Map<string, unknown>()
  return { data, get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, set: (key: string, value: unknown) => void data.set(key, value) }
}

test("auto-approve is not remembered across a restart", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "auto")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
  expect(restoredMode(kv, "/work/b", false)).toBe("normal")
  expect(kv.data.has(autoAcceptKey("/work/a"))).toBe(false)
})

test("a stored auto-approve value from an older build is ignored", () => {
  const kv = memory()
  kv.set(autoAcceptKey("/work/a"), true)
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})

test("turning auto-approve off leaves the project storing nothing", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "auto")
  saveMode(kv, "/work/a", "normal")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
  expect(kv.data.size).toBe(0)
})

test("the launch flag wins and nothing stored means normal", () => {
  const kv = memory()
  expect(restoredMode(kv, "/work/a", true)).toBe("auto")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})

test("careful is remembered per project and round-trips through restore", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "careful")
  expect(restoredMode(kv, "/work/a", false)).toBe("careful")
  expect(restoredMode(kv, "/work/b", false)).toBe("normal")
  expect(kv.data.get(carefulKey("/work/a"))).toBe(true)
  expect(kv.data.has(autoAcceptKey("/work/a"))).toBe(false)
})

test("switching between careful, auto and normal leaves only careful stored", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "careful")
  saveMode(kv, "/work/a", "auto")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
  expect(kv.data.get(carefulKey("/work/a"))).toBe(false)
  saveMode(kv, "/work/a", "careful")
  expect(restoredMode(kv, "/work/a", false)).toBe("careful")
  expect(kv.data.has(autoAcceptKey("/work/a"))).toBe(false)
  saveMode(kv, "/work/a", "normal")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})

test("an unknown stored value falls back to normal", () => {
  const kv = memory()
  kv.set(carefulKey("/work/a"), "yes")
  kv.set(autoAcceptKey("/work/a"), "careful")
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
  kv.set(autoAcceptKey("/work/a"), 1)
  expect(restoredMode(kv, "/work/a", false)).toBe("normal")
})

test("a stored auto flag never beats careful", () => {
  const kv = memory()
  kv.set(autoAcceptKey("/work/a"), true)
  kv.set(carefulKey("/work/a"), true)
  expect(restoredMode(kv, "/work/a", false)).toBe("careful")
})

test("the launch flag still beats a stored careful profile", () => {
  const kv = memory()
  saveMode(kv, "/work/a", "careful")
  expect(restoredMode(kv, "/work/a", true)).toBe("auto")
})
