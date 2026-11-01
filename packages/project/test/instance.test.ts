import { describe, expect, test } from "bun:test"
import { Instance } from "../src/instance"

describe("Instance.provide directory guard", () => {
  test("refuses the filesystem root and protected system directories", async () => {
    for (const directory of ["/", "/etc", "/etc/ssl", "/proc", "/sys/kernel"]) {
      await expect(Instance.provide({ directory, fn: () => 1 })).rejects.toThrow("Access denied")
    }
  })
})
