import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "@opencode-ai/core/util"
import { Flock } from "@opencode-ai/shared/util/flock"
import { Global } from "@opencode-ai/core/global"

const { data, cache, config, state, memory } = Global.Path

export const Path = {
  // HOME/USERPROFILE read directly because Bun caches os.homedir() at startup.
  // Tests set these env vars to isolate from the developer's real home.
  get home() {
    return process.env.HOME || process.env.USERPROFILE || os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  memory,
  cache,
  config,
  state,
}

// Fixed, launch-directory-independent home for the globally-unique Orchestrator
// session. Lives under the global data root so switching into orchestrator mode
// from anywhere always lands on the same workspace/session. Children get their
// own --dir/--isolate, so this dir does not need to be a git repo. Created on
// first use.
export async function orchestratorDir() {
  const dir = path.join(Path.data, "orchestrator")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Initialize Flock with global state path
Flock.setGlobal({ state })

// Directories are created by @opencode-ai/core/global on import -- this module
// re-exports the path constants and does not need its own mkdir.
const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch {}
  await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
}

export * as Global from "."
