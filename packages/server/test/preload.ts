import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll } from "bun:test"

const testDataDir = join(tmpdir(), `opencode-test-data-${process.pid}`)
const testDbPath = join(testDataDir, "test.db")

beforeAll(async () => {
  await mkdir(testDataDir, { recursive: true })
  process.env.OPENCODE_DB = testDbPath
  process.env.HORDECODE_DB = testDbPath
  process.env.XDG_DATA_HOME = testDataDir
  process.env.XDG_CONFIG_HOME = testDataDir
  process.env.XDG_STATE_HOME = testDataDir
  // Avoid any real provider/auth SDK calls during tests
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENCODE_API_KEY",
    "HORDECODE_CONSOLE_TOKEN",
  ]) {
    delete process.env[key]
  }
})

afterAll(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(testDataDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})
