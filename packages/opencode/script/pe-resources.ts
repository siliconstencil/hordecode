import fs from "fs"

// Bun only embeds a Windows icon and version strings when it runs on Windows ("--windows-icon is only available when
// compiling on Windows"). The release build runs on Linux, so the executable keeps Bun's own icon and company name.
// This rewrites those resources in place: the icon slot (RT_ICON) takes the largest image of an .ico file, and the version
// slot (RT_VERSION) is rebuilt from the given strings. Both new blobs must fit the slots Bun reserved; the resource
// directory, section sizes and entry points are not touched.

const RT_ICON = 3
const RT_GROUP_ICON = 14
const RT_VERSION = 16

export interface VersionInfo {
  version: string // "0.1.2.0"
  strings: Record<string, string>
}

interface Leaf {
  path: number[]
  entry: number // file offset of the IMAGE_RESOURCE_DATA_ENTRY
  offset: number // file offset of the data
  size: number
}

function parse(buf: Buffer) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file")
  const pe = buf.readUInt32LE(0x3c)
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("not a PE file")
  const sections = buf.readUInt16LE(pe + 6)
  const optional = buf.readUInt16LE(pe + 20)
  const magic = buf.readUInt16LE(pe + 24)
  const directories = pe + 24 + (magic === 0x20b ? 112 : 96)
  const rva = buf.readUInt32LE(directories + 16)
  if (rva === 0) throw new Error("the executable has no resource directory")
  const table = pe + 24 + optional
  const toOffset = (value: number) => {
    for (let i = 0; i < sections; i++) {
      const at = table + 40 * i
      const virtualSize = buf.readUInt32LE(at + 8)
      const virtualAddress = buf.readUInt32LE(at + 12)
      const rawSize = buf.readUInt32LE(at + 16)
      const rawPointer = buf.readUInt32LE(at + 20)
      if (value >= virtualAddress && value < virtualAddress + Math.max(virtualSize, rawSize)) return rawPointer + value - virtualAddress
    }
    throw new Error(`address ${value.toString(16)} is outside every section`)
  }
  const base = toOffset(rva)
  const leaves: Leaf[] = []
  const walk = (at: number, path: number[]) => {
    const count = buf.readUInt16LE(at + 12) + buf.readUInt16LE(at + 14)
    for (let i = 0; i < count; i++) {
      const id = buf.readUInt32LE(at + 16 + 8 * i)
      const next = buf.readUInt32LE(at + 20 + 8 * i)
      if (next & 0x80000000) walk(base + (next & 0x7fffffff), [...path, id])
      else {
        const entry = base + next
        leaves.push({ path: [...path, id], entry, offset: toOffset(buf.readUInt32LE(entry)), size: buf.readUInt32LE(entry + 4) })
      }
    }
  }
  walk(base, [])
  return leaves
}

function pad4(length: number) {
  return (4 - (length % 4)) % 4
}

function utf16(text: string) {
  return Buffer.from(`${text}\0`, "utf16le")
}

// A VS_VERSIONINFO node: wLength, wValueLength, wType, key, padding, value, children.
function node(key: string, type: number, value: Buffer, children: Buffer[] = [], valueLength = value.length): Buffer {
  const head = Buffer.alloc(6)
  const keyBytes = utf16(key)
  const afterKey = Buffer.alloc(pad4(6 + keyBytes.length))
  const body = Buffer.concat(children.flatMap((child, i) => [child, Buffer.alloc(i < children.length - 1 ? pad4(child.length) : 0)]))
  const afterValue = Buffer.alloc(value.length > 0 && children.length > 0 ? pad4(6 + keyBytes.length + afterKey.length + value.length) : 0)
  const out = Buffer.concat([head, keyBytes, afterKey, value, afterValue, body])
  out.writeUInt16LE(out.length, 0)
  out.writeUInt16LE(valueLength, 2)
  out.writeUInt16LE(type, 4)
  return out
}

export function versionResource(info: VersionInfo): Buffer {
  const parts = info.version.split(".").map((item) => Number(item))
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 65535)) throw new Error(`bad version ${info.version}`)
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0)
  fixed.writeUInt32LE(0x00010000, 4)
  fixed.writeUInt32LE((parts[0] << 16) | parts[1], 8)
  fixed.writeUInt32LE((parts[2] << 16) | parts[3], 12)
  fixed.writeUInt32LE((parts[0] << 16) | parts[1], 16)
  fixed.writeUInt32LE((parts[2] << 16) | parts[3], 20)
  fixed.writeUInt32LE(0x3f, 24)
  fixed.writeUInt32LE(0x00040004, 32) // VOS_NT_WINDOWS32
  fixed.writeUInt32LE(0x1, 36) // VFT_APP
  const strings = Object.entries(info.strings).map(([name, text]) => {
    const value = utf16(text)
    return node(name, 1, value, [], value.length / 2)
  })
  const table = node("040904b0", 1, Buffer.alloc(0), strings, 0)
  const translation = Buffer.alloc(4)
  translation.writeUInt16LE(0x0409, 0)
  translation.writeUInt16LE(0x04b0, 2)
  const vars = node("VarFileInfo", 1, Buffer.alloc(0), [node("Translation", 0, translation)], 0)
  return node("VS_VERSION_INFO", 0, fixed, [node("StringFileInfo", 1, Buffer.alloc(0), [table], 0), vars], fixed.length)
}

// The largest image of an .ico file: [bytes, width, height, planes, bitCount].
function largestIcon(ico: Buffer) {
  if (ico.readUInt16LE(2) !== 1) throw new Error("not an .ico file")
  let best: { bytes: Buffer; width: number; height: number; planes: number; bits: number } | undefined
  for (let i = 0, count = ico.readUInt16LE(4); i < count; i++) {
    const at = 6 + 16 * i
    const width = ico[at] || 256
    const height = ico[at + 1] || 256
    const bytes = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8))
    if (!best || width * height > best.width * best.height)
      best = { bytes, width, height, planes: ico.readUInt16LE(at + 4) || 1, bits: ico.readUInt16LE(at + 6) || 32 }
  }
  if (!best) throw new Error("the .ico file has no images")
  return best
}

export interface PatchResult {
  icon: { width: number; height: number; bytes: number; slot: number }
  version: { bytes: number; slot: number }
}

export function patchResources(file: string, input: { ico: string; version: VersionInfo }): PatchResult {
  const buf = fs.readFileSync(file)
  const leaves = parse(buf)
  const find = (type: number) => {
    const leaf = leaves.find((item) => item.path[0] === type)
    if (!leaf) throw new Error(`the executable has no resource of type ${type}`)
    return leaf
  }
  const icon = largestIcon(fs.readFileSync(input.ico))
  const iconLeaf = find(RT_ICON)
  const groupLeaf = find(RT_GROUP_ICON)
  const versionLeaf = find(RT_VERSION)
  const version = versionResource(input.version)
  if (icon.bytes.length > iconLeaf.size) throw new Error(`icon image (${icon.bytes.length} bytes) does not fit its slot (${iconLeaf.size})`)
  if (version.length > versionLeaf.size) throw new Error(`version resource (${version.length} bytes) does not fit its slot (${versionLeaf.size})`)
  if (groupLeaf.size < 20) throw new Error("unexpected icon group size")

  buf.fill(0, iconLeaf.offset, iconLeaf.offset + iconLeaf.size)
  icon.bytes.copy(buf, iconLeaf.offset)
  buf.writeUInt32LE(icon.bytes.length, iconLeaf.entry + 4)

  const iconID = buf.readUInt16LE(groupLeaf.offset + 6 + 12)
  const group = Buffer.alloc(20)
  group.writeUInt16LE(1, 2)
  group.writeUInt16LE(1, 4)
  group[6] = icon.width === 256 ? 0 : icon.width
  group[7] = icon.height === 256 ? 0 : icon.height
  group.writeUInt16LE(icon.planes, 10)
  group.writeUInt16LE(icon.bits, 12)
  group.writeUInt32LE(icon.bytes.length, 14)
  group.writeUInt16LE(iconID, 18)
  buf.fill(0, groupLeaf.offset, groupLeaf.offset + groupLeaf.size)
  group.copy(buf, groupLeaf.offset)
  buf.writeUInt32LE(group.length, groupLeaf.entry + 4)

  buf.fill(0, versionLeaf.offset, versionLeaf.offset + versionLeaf.size)
  version.copy(buf, versionLeaf.offset)
  buf.writeUInt32LE(version.length, versionLeaf.entry + 4)

  fs.writeFileSync(file, buf)
  return {
    icon: { width: icon.width, height: icon.height, bytes: icon.bytes.length, slot: iconLeaf.size },
    version: { bytes: version.length, slot: versionLeaf.size },
  }
}
