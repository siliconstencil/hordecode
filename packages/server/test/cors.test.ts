import { describe, expect, it } from "bun:test"
import { isAllowedCorsOrigin, isAllowedRequestOrigin, type CorsOptions } from "../src/cors"

const allowlist: CorsOptions = {
  cors: ["https://app.example.com", "https://staging.opencode.ai"],
}

describe("isAllowedCorsOrigin", () => {
  it("allows undefined origin", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true)
  })

  it("allows http://localhost:<port>", () => {
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
  })

  it("allows http://127.0.0.1:<port>", () => {
    expect(isAllowedCorsOrigin("http://127.0.0.1:8080")).toBe(true)
  })

  it("allows oc://renderer", () => {
    expect(isAllowedCorsOrigin("oc://renderer")).toBe(true)
  })

  it("allows tauri origins", () => {
    expect(isAllowedCorsOrigin("tauri://localhost")).toBe(true)
    expect(isAllowedCorsOrigin("http://tauri.localhost")).toBe(true)
    expect(isAllowedCorsOrigin("https://tauri.localhost")).toBe(true)
  })

  it("allows opencode.ai and its subdomains", () => {
    expect(isAllowedCorsOrigin("https://opencode.ai")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.opencode.ai")).toBe(true)
    expect(isAllowedCorsOrigin("https://deep.sub.opencode.ai")).toBe(true)
  })

  it("rejects unknown origin when no allowlist given", () => {
    expect(isAllowedCorsOrigin("https://evil.example.com")).toBe(false)
  })

  it("rejects unknown origin not present in allowlist", () => {
    expect(isAllowedCorsOrigin("https://evil.example.com", allowlist)).toBe(false)
  })

  it("allows origin present in allowlist", () => {
    expect(isAllowedCorsOrigin("https://app.example.com", allowlist)).toBe(true)
  })

  it("matches opencode.ai subdomain before consulting allowlist", () => {
    expect(isAllowedCorsOrigin("https://staging.opencode.ai", allowlist)).toBe(true)
  })
})

describe("isAllowedRequestOrigin", () => {
  it("allows undefined origin", () => {
    expect(isAllowedRequestOrigin(undefined, "localhost:3000")).toBe(true)
  })

  it("allows origin whose host equals the request host", () => {
    expect(isAllowedRequestOrigin("http://localhost:3000", "localhost:3000")).toBe(true)
  })

  it("rejects origin on a different host when not allowlisted", () => {
    expect(isAllowedRequestOrigin("https://evil.example.com", "localhost:3000")).toBe(false)
  })

  it("allows origin on a different host when present in allowlist", () => {
    expect(isAllowedRequestOrigin("https://app.example.com", "localhost:3000", allowlist)).toBe(true)
  })
})
