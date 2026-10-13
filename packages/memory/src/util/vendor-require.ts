import fs from "node:fs"
import path from "node:path"

export function vendorRequire(): unknown {
  try {
    const exeDir = path.dirname(process.execPath)
    const vendorPkg = path.join(exeDir, "vendor", "node_modules", "@huggingface", "transformers")
    if (fs.existsSync(vendorPkg)) return require(vendorPkg)
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@huggingface/transformers")
  } catch {
    return null
  }
}
