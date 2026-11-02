import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { assertSafeUrl, resolver } from "../../src/util/ssrf"

const realLookup = resolver.lookup
const resolveTo = (address: string, family: 4 | 6 = 4) => {
  resolver.lookup = (async () => ({ address, family })) as unknown as typeof resolver.lookup
}
beforeEach(() => resolveTo("93.184.216.34"))
afterEach(() => {
  resolver.lookup = realLookup
})

describe("assertSafeUrl", () => {
  test("accepts a hostname that resolves to a public address", async () => {
    await expect(assertSafeUrl("http://example.com/a")).resolves.toBeUndefined()
  })

  test("blocks metadata hostnames before any lookup", async () => {
    resolver.lookup = (async () => {
      throw new Error("lookup must not run")
    }) as unknown as typeof resolver.lookup
    await expect(assertSafeUrl("http://metadata.google.internal/x")).rejects.toThrow("blocked hostname")
  })

  test("blocks numeric private IPv4 and IPv6 literals", async () => {
    for (const url of ["http://10.0.0.1/", "http://172.16.0.9/", "http://192.168.1.5/", "http://169.254.169.254/", "http://100.64.0.1/", "http://[fe80::1]/", "http://[fd00::1]/"])
      await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
  })

  test("blocks a hostname that resolves to a private address (DNS rebinding)", async () => {
    resolveTo("10.1.2.3")
    await expect(assertSafeUrl("http://rebind.example/")).rejects.toThrow('resolves to blocked IP "10.1.2.3"')
    resolveTo("fe80::1", 6)
    await expect(assertSafeUrl("http://rebind6.example/")).rejects.toThrow("resolves to blocked IPv6")
  })

  test("loopback is allowed on purpose: local development servers can be fetched", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:3000/")).resolves.toBeUndefined()
    await expect(assertSafeUrl("http://[::1]/")).resolves.toBeUndefined()
  })

  test("fails closed when the name does not resolve", async () => {
    resolver.lookup = (async () => {
      throw new Error("ENOTFOUND")
    }) as unknown as typeof resolver.lookup
    await expect(assertSafeUrl("http://nope.invalid/")).rejects.toThrow('DNS resolution failed for "nope.invalid"')
  })
})
