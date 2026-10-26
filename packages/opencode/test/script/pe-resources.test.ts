import { afterEach, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { patchResources, versionResource } from "../../script/pe-resources"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ICON_SLOT = 600
const VERSION_SLOT = 700
const RSRC_RVA = 0x1000
const RSRC_RAW = 0x400

function directory(entries: Array<[number, number]>) {
  const out = Buffer.alloc(16 + 8 * entries.length)
  out.writeUInt16LE(entries.length, 14)
  entries.forEach(([id, target], i) => {
    out.writeUInt32LE(id, 16 + 8 * i)
    out.writeUInt32LE(target, 20 + 8 * i)
  })
  return out
}

// A minimal PE32+ with one section holding a resource tree of RT_ICON, RT_GROUP_ICON and RT_VERSION, each id 1, language 1033.
function pe() {
  const types = [3, 14, 16]
  const slots: Record<number, number> = { 3: ICON_SLOT, 14: 20, 16: VERSION_SLOT }
  const root = 16 + 8 * 3
  const nameAt = (i: number) => root + i * 24 // name directory i: 16 byte header plus one entry
  const langAt = (i: number) => nameAt(3) + i * 24
  const entryAt = (i: number) => langAt(3) + i * 16
  const dataAt = entryAt(3)
  const tree = Buffer.alloc(dataAt + ICON_SLOT + 20 + VERSION_SLOT)
  directory(types.map((type, i) => [type, (0x80000000 | nameAt(i)) >>> 0])).copy(tree, 0)
  types.forEach((type, i) => {
    directory([[1, (0x80000000 | langAt(i)) >>> 0]]).copy(tree, nameAt(i))
    directory([[1033, entryAt(i)]]).copy(tree, langAt(i))
    const offset = dataAt + types.slice(0, i).reduce((sum, t) => sum + slots[t], 0)
    tree.writeUInt32LE(RSRC_RVA + offset, entryAt(i))
    tree.writeUInt32LE(slots[type], entryAt(i) + 4)
    tree.fill(0xaa, offset, offset + slots[type])
  })
  // The group entry names icon id 7.
  const groupOffset = dataAt + ICON_SLOT
  tree.writeUInt16LE(1, groupOffset + 2)
  tree.writeUInt16LE(1, groupOffset + 4)
  tree.writeUInt16LE(7, groupOffset + 6 + 12)

  const header = Buffer.alloc(RSRC_RAW)
  header.write("MZ", 0, "latin1")
  header.writeUInt32LE(0x40, 0x3c)
  header.write("PE\0\0", 0x40, "latin1")
  header.writeUInt16LE(0x8664, 0x44)
  header.writeUInt16LE(1, 0x46)
  header.writeUInt16LE(240, 0x54)
  header.writeUInt16LE(0x20b, 0x58)
  header.writeUInt32LE(RSRC_RVA, 0x58 + 112 + 16)
  header.writeUInt32LE(tree.length, 0x58 + 112 + 20)
  const section = 0x40 + 24 + 240
  header.write(".rsrc", section, "latin1")
  header.writeUInt32LE(tree.length, section + 8)
  header.writeUInt32LE(RSRC_RVA, section + 12)
  header.writeUInt32LE(tree.length, section + 16)
  header.writeUInt32LE(RSRC_RAW, section + 20)
  return Buffer.concat([header, tree])
}

function ico(png: Buffer) {
  const head = Buffer.alloc(22)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(1, 4)
  head.writeUInt16LE(1, 10)
  head.writeUInt16LE(32, 12)
  head.writeUInt32LE(png.length, 14)
  head.writeUInt32LE(22, 18)
  return Buffer.concat([head, png])
}

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-resources-"))
  dirs.push(dir)
  const exe = path.join(dir, "app.exe")
  const icon = path.join(dir, "icon.ico")
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(96, 7)])
  fs.writeFileSync(exe, pe())
  fs.writeFileSync(icon, ico(png))
  return { exe, icon, png }
}

const version = { version: "0.1.2.0", strings: { CompanyName: "Silicon Stencil", ProductName: "Hordecode", FileVersion: "0.1.2" } }

test("the icon and version slots are rewritten and their sizes updated", () => {
  const { exe, icon, png } = files()
  const result = patchResources(exe, { ico: icon, version })
  expect(result.icon).toEqual({ width: 256, height: 256, bytes: png.length, slot: ICON_SLOT })
  expect(result.version.slot).toBe(VERSION_SLOT)

  const buf = fs.readFileSync(exe)
  const tree = RSRC_RAW
  const dataAt = 16 + 24 + 3 * 24 + 3 * 24 + 3 * 16
  expect(buf.subarray(tree + dataAt, tree + dataAt + png.length)).toEqual(png)
  expect(buf[tree + dataAt + png.length]).toBe(0)
  const entry = (i: number) => tree + 16 + 24 + 3 * 24 + 3 * 24 + i * 16
  expect(buf.readUInt32LE(entry(0) + 4)).toBe(png.length)
  expect(buf.readUInt32LE(entry(1) + 4)).toBe(20)
  expect(buf.readUInt32LE(entry(2) + 4)).toBe(result.version.bytes)
  const group = tree + dataAt + ICON_SLOT
  expect(buf.readUInt16LE(group + 4)).toBe(1)
  expect(buf.readUInt32LE(group + 6 + 8)).toBe(png.length)
  expect(buf.readUInt16LE(group + 6 + 12)).toBe(7)
})

test("the version resource is a consistent VS_VERSIONINFO with the given strings", () => {
  const blob = versionResource(version)
  expect(blob.readUInt16LE(0)).toBe(blob.length)
  const text = blob.toString("utf16le")
  for (const value of ["VS_VERSION_INFO", "StringFileInfo", "040904b0", "CompanyName", "Silicon Stencil", "ProductName", "Hordecode", "VarFileInfo", "Translation"])
    expect(text).toContain(value)
  expect(blob.readUInt32LE(40)).toBe(0xfeef04bd)
  expect(blob.readUInt32LE(48)).toBe(1)
  expect(blob.readUInt32LE(52)).toBe(2 << 16)
})

test("a blob that does not fit its slot is refused", () => {
  const { exe, icon } = files()
  const strings = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Key${i}`, "x".repeat(40)]))
  expect(() => patchResources(exe, { ico: icon, version: { version: "1.0.0.0", strings } })).toThrow("does not fit")
  expect(() => patchResources(exe, { ico: icon, version: { version: "1.0", strings: {} } })).toThrow("bad version")
})

test("a file without a resource directory is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-resources-"))
  dirs.push(dir)
  const exe = path.join(dir, "plain.exe")
  const buf = pe()
  buf.writeUInt32LE(0, 0x58 + 112 + 16)
  fs.writeFileSync(exe, buf)
  expect(() => patchResources(exe, { ico: path.join(dir, "none.ico"), version })).toThrow("no resource directory")
})
