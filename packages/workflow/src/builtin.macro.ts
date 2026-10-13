import fs from "fs"
import path from "path"

// Read at build time so the sources inline into the bundle and never enter the module graph,
// which avoids a Bun macro / ESM text-import collision. Sorted for a deterministic bundle.
export function loadBuiltinScripts() {
  const dir = path.resolve(import.meta.dir, "builtin")
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => ({ file, script: fs.readFileSync(path.join(dir, file), "utf8") }))
}
