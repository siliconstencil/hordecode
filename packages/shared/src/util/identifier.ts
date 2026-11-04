import { randomBytes } from "crypto"

export namespace Identifier {
  // Payload is always 26 chars: sort mark ("g" ascending, "-" descending) + 16 hex of the 64-bit time field + base62.
  // v1 was 12 hex + 14 base62 (48-bit time, wrapped on 2026-08-14); "g" > "f" and "-" < "0" keep v2 order-compatible.
  const LENGTH = 26
  const TIME_BYTES = 8

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending() {
    return create(false)
  }

  export function descending() {
    return create(true)
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(TIME_BYTES)
    for (let i = 0; i < TIME_BYTES; i++) {
      timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
    }

    return (descending ? "-" : "g") + timeBytes.toString("hex") + randomBase62(LENGTH - 1 - TIME_BYTES * 2)
  }
}
