import { createHash } from "crypto"
import fs from "fs"

const LC_CODE_SIGNATURE = 0x1d
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0
const CSMAGIC_CODEDIRECTORY = 0xfade0c02
const CSMAGIC_ALTERNATE_CODEDIRECTORY = 0xfade0c05
const HASH_ALGORITHM: Record<number, string> = { 1: "sha1", 2: "sha256", 3: "sha256", 4: "sha384" }

export interface RehashResult {
  directories: number
  pages: number
  changed: number
}

// Rewrites the page hashes of an existing ad-hoc CodeDirectory in place. A build that edits bytes after
// Bun signed the binary (the source path scrub) leaves those hashes stale, and macOS 27 and later kills a
// process that pages in a stale page. `codesign` is only available on macOS, so a Linux build cannot re-sign.
export function rehashMachO(file: string): RehashResult | undefined {
  const buf = fs.readFileSync(file)
  if (buf.length < 32 || buf.readUInt32LE(0) !== 0xfeedfacf) return undefined
  const ncmds = buf.readUInt32LE(16)
  let signature: { offset: number; size: number } | undefined
  for (let at = 32, i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(at)
    const size = buf.readUInt32LE(at + 4)
    if (cmd === LC_CODE_SIGNATURE) signature = { offset: buf.readUInt32LE(at + 8), size: buf.readUInt32LE(at + 12) }
    at += size
  }
  if (!signature) return undefined
  const blob = signature.offset
  if (buf.readUInt32BE(blob) !== CSMAGIC_EMBEDDED_SIGNATURE) return undefined
  const result: RehashResult = { directories: 0, pages: 0, changed: 0 }
  for (let i = 0, count = buf.readUInt32BE(blob + 8); i < count; i++) {
    const dir = blob + buf.readUInt32BE(blob + 12 + 8 * i + 4)
    const magic = buf.readUInt32BE(dir)
    if (magic !== CSMAGIC_CODEDIRECTORY && magic !== CSMAGIC_ALTERNATE_CODEDIRECTORY) continue
    const hashOffset = buf.readUInt32BE(dir + 16)
    const codeSlots = buf.readUInt32BE(dir + 28)
    const codeLimit = buf.readUInt32BE(dir + 32)
    const hashSize = buf.readUInt8(dir + 36)
    const algorithm = HASH_ALGORITHM[buf.readUInt8(dir + 37)]
    const page = 2 ** buf.readUInt8(dir + 39)
    if (!algorithm || page === 1) continue
    result.directories++
    for (let slot = 0; slot < codeSlots; slot++) {
      const start = slot * page
      const hash = createHash(algorithm)
        .update(buf.subarray(start, Math.min(start + page, codeLimit)))
        .digest()
        .subarray(0, hashSize)
      const at = dir + hashOffset + slot * hashSize
      result.pages++
      if (!hash.equals(buf.subarray(at, at + hashSize))) {
        hash.copy(buf, at)
        result.changed++
      }
    }
  }
  if (result.changed > 0) fs.writeFileSync(file, buf)
  return result
}
