import { afterEach, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { rehashMachO } from "../../script/macho-rehash"

const PAGE = 4096
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// A thin 64-bit Mach-O shell: header, one LC_CODE_SIGNATURE command, three pages of code, then the signature blob
// with a SHA-256 CodeDirectory that covers those pages.
function build() {
  const pages = 3
  const limit = pages * PAGE
  const buf = Buffer.alloc(limit + 12 + 8 + 44 + pages * 32)
  buf.writeUInt32LE(0xfeedfacf, 0)
  buf.writeUInt32LE(1, 16)
  buf.writeUInt32LE(16, 20)
  buf.writeUInt32LE(0x1d, 32)
  buf.writeUInt32LE(16, 36)
  buf.writeUInt32LE(limit, 40)
  buf.writeUInt32LE(buf.length - limit, 44)
  for (let i = 100; i < limit; i++) buf[i] = i % 251
  const blob = limit
  buf.writeUInt32BE(0xfade0cc0, blob)
  buf.writeUInt32BE(buf.length - limit, blob + 4)
  buf.writeUInt32BE(1, blob + 8)
  buf.writeUInt32BE(0, blob + 12)
  buf.writeUInt32BE(20, blob + 16)
  const dir = blob + 20
  buf.writeUInt32BE(0xfade0c02, dir)
  buf.writeUInt32BE(44 + pages * 32, dir + 4)
  buf.writeUInt32BE(44, dir + 16)
  buf.writeUInt32BE(pages, dir + 28)
  buf.writeUInt32BE(limit, dir + 32)
  buf.writeUInt8(32, dir + 36)
  buf.writeUInt8(2, dir + 37)
  buf.writeUInt8(12, dir + 39)
  for (let i = 0; i < pages; i++) createHash("sha256").update(buf.subarray(i * PAGE, (i + 1) * PAGE)).digest().copy(buf, dir + 44 + i * 32)
  return buf
}

function write(buf: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macho-rehash-"))
  dirs.push(dir)
  const file = path.join(dir, "bin")
  fs.writeFileSync(file, buf)
  return file
}

test("a signature that matches the bytes is left alone", () => {
  const file = write(build())
  expect(rehashMachO(file)).toEqual({ directories: 1, pages: 3, changed: 0 })
})

test("bytes edited after signing get their page hashes rewritten, once", () => {
  const buf = build()
  buf.write("/hordecode-build/", PAGE + 10)
  const file = write(buf)
  expect(rehashMachO(file)).toEqual({ directories: 1, pages: 3, changed: 1 })
  expect(rehashMachO(file)).toEqual({ directories: 1, pages: 3, changed: 0 })
})

test("a file that is not a signed 64-bit Mach-O is ignored", () => {
  expect(rehashMachO(write(Buffer.from("MZ not a mach-o file, padded to be long enough for a header....")))).toBeUndefined()
})
