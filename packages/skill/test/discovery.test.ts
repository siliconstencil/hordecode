import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { Discovery } from "../src/discovery"
import { Global } from "@opencode-ai/global"
import { rm } from "fs/promises"
import path from "path"

let SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0

// Inline fixture served from memory (no external fixture dir).
// `no-md-skill` deliberately omits SKILL.md to exercise the index filter.
const fixture = {
  "good-skill": {
    files: ["SKILL.md", "references/guide.md"],
    body: {
      "SKILL.md": "---\nname: good-skill\n---\n",
      "references/guide.md": "# guide\n",
    },
  },
  "no-md-skill": {
    files: ["README.md"],
    body: {
      "README.md": "# no md\n",
    },
  },
} as const

const cacheDir = path.join(Global.Path.cache, "skills")

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/.well-known/skills/index.json") {
        const index = {
          skills: Object.entries(fixture).map(([name, s]) => ({ name, files: [...s.files] })),
        }
        return Response.json(index)
      }

      const match = url.pathname.match(/^\/\.well-known\/skills\/([^/]+)\/(.+)$/)
      if (match) {
        const [, name, file] = match
        const skill = fixture[name as keyof typeof fixture]
        const content = skill?.body[file as keyof typeof skill.body]
        if (content !== undefined) {
          if (!file.endsWith("index.json")) downloadCount++
          return new Response(content)
        }
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

afterAll(async () => {
  void server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  const pull = (url: string) =>
    Effect.runPromise(Discovery.Service.use((s) => s.pull(url)).pipe(Effect.provide(Discovery.defaultLayer)))

  test("downloads skills with SKILL.md into the cache", async () => {
    const dirs = await pull(SKILLS_URL)
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(dir).toStartWith(cacheDir)
      expect(await Bun.file(path.join(dir, "SKILL.md")).exists()).toBe(true)
    }
  })

  test("url without trailing slash works", async () => {
    const dirs = await pull(SKILLS_URL.replace(/\/$/, ""))
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(await Bun.file(path.join(dir, "SKILL.md")).exists()).toBe(true)
    }
  })

  test("returns empty array for invalid url", async () => {
    const dirs = await pull(`http://localhost:${server.port}/invalid-url/`)
    expect(dirs).toEqual([])
  })

  test("returns empty array for non-json response", async () => {
    const dirs = await pull(`http://localhost:${server.port}/some-other-path/`)
    expect(dirs).toEqual([])
  })

  test("filters out skill entries missing SKILL.md", async () => {
    const dirs = await pull(SKILLS_URL)
    const names = dirs.map((d) => path.basename(d))
    expect(names).toContain("good-skill")
    expect(names).not.toContain("no-md-skill")
  })

  test("downloads reference files alongside SKILL.md", async () => {
    const dirs = await pull(SKILLS_URL)
    const good = dirs.find((d) => path.basename(d) === "good-skill")
    expect(good).toBeDefined()
    if (good) {
      expect(await Bun.file(path.join(good, "SKILL.md")).exists()).toBe(true)
      expect(await Bun.file(path.join(good, "references", "guide.md")).exists()).toBe(true)
    }
  })

  test("caches downloaded files on second pull", async () => {
    await rm(cacheDir, { recursive: true, force: true })
    downloadCount = 0

    const first = await pull(SKILLS_URL)
    expect(first.length).toBeGreaterThan(0)
    const firstCount = downloadCount
    expect(firstCount).toBeGreaterThan(0)

    const second = await pull(SKILLS_URL)
    expect(second.length).toBe(first.length)
    expect(second.sort()).toEqual(first.sort())

    // second pull served from cache, no new downloads
    expect(downloadCount).toBe(firstCount)
  })
})
