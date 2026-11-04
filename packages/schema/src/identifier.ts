// Payload is always 26 chars: a sort mark ("g" ascending, "-" descending), 16 hex of the 64-bit time field,
// 9 base62. v1 was 12 hex + 14 base62 and kept only the low 48 bits of timestamp * 4096 + counter, wrapping every 2^36 ms
// (the 26th wrap was 2026-08-14). "g" sorts after every v1 hex digit and "-" before "0", so v2 ids stay
// order-compatible with v1 ids in both directions. MiMo Code 54ec2d5e, packages/shared/src/util/identifier.ts:7-8, 45-51 at v0.1.16.
const length = 26
const timeBytes = 8
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: timeBytes }, (_, index) =>
    Number((value >> BigInt(56 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 1 - timeBytes * 2))
  return (descending ? "-" : "g") + time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
