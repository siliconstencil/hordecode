import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "hordecode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("models path lives under Global.Path.cache (not data) and is created on module load", async () => {
    // Models must live under the cache root, not the data root -- they're
    // regenerable downloads (~133 MB embedding model), so a data wipe must
    // NOT wipe them, and a cache wipe MUST.
    expect(Global.Path.models).toBe(path.join(Global.Path.cache, "models"))
    expect(Global.make().models).toBe(Global.Path.models)
    expect((await fs.stat(Global.Path.models)).isDirectory()).toBe(true)
  })
})
