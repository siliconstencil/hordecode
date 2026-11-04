const prefixes = {
  session: "ses",
  message: "msg",
  permission: "per",
  user: "usr",
  part: "prt",
  pty: "pty",
} as const

// Same layout as packages/schema/src/identifier.ts: mark + 16 hex (64-bit time) + 9 base62, so ids minted here sort with server ids.
const LENGTH = 26
const TIME_BYTES = 8
let lastTimestamp = 0
let counter = 0

type Prefix = keyof typeof prefixes
export namespace Identifier {
  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }
}

function generateID(prefix: Prefix, descending: boolean, given?: string): string {
  if (!given) {
    return create(prefix, descending)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }

  return given
}

function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }

  counter += 1

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  if (descending) {
    now = ~now
  }

  const timeBytes = new Uint8Array(TIME_BYTES)
  for (let i = 0; i < TIME_BYTES; i += 1) {
    timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
  }

  return prefixes[prefix] + "_" + (descending ? "-" : "g") + bytesToHex(timeBytes) + randomBase62(LENGTH - 1 - TIME_BYTES * 2)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = getRandomBytes(length)
  let result = ""
  for (let i = 0; i < length; i += 1) {
    result += chars[bytes[i] % 62]
  }
  return result
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes)
    return bytes
  }

  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256)
  }

  return bytes
}
