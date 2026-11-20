import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"

// K6c: the recording language server shared by the trust suites. It parses the LSP
// frames on stdin, writes the initialize body to the marker path, and answers every
// request. A test that installs it in the managed package cache (where Npm.which
// resolves) or at a language server's own path observes whether that server was
// started and what initialization options it received. Answering initialize matters:
// a server that never replies leaves the client's handshake pending, and interrupting
// that request races the client shutdown into a destroyed-stream rejection.
function recorderBody(out: string) {
  return [
    // The eslint server is spawned as `node <path>`; this file must parse as CJS
    // there, or the child exits before the client's initialize frame.
    'const fs = require("node:fs")',
    `const out = ${out}`,
    "let buf = Buffer.alloc(0)",
    "const send = (message) => {",
    "  const json = JSON.stringify(message)",
    '  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json)',
    "}",
    "const parse = () => {",
    "  while (true) {",
    '    const head = buf.indexOf("\\r\\n\\r\\n")',
    "    if (head < 0) return",
    '    const match = /content-length:\\s*(\\d+)/i.exec(buf.subarray(0, head).toString())',
    "    if (!match) return",
    "    const length = Number(match[1])",
    "    if (buf.length < head + 4 + length) return",
    "    const body = buf.subarray(head + 4, head + 4 + length).toString()",
    "    buf = buf.subarray(head + 4 + length)",
    "    let message",
    "    try { message = JSON.parse(body) } catch { continue }",
    '    if (message.method === "initialize") fs.writeFileSync(out, body)',
    "    if (message.id === undefined) continue",
    '    send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null })',
    "  }",
    "}",
    'process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); parse() })',
    // Outlive the test scope: a recorder that exits first makes the client's
    // shutdown write reject on the destroyed stdin.
    "setTimeout(() => process.exit(0), 60000)",
    "",
  ].join("\n")
}

// A runnable source that records to an absolute marker path, for `node -e`.
export function recorderAt(out: string) {
  return recorderBody(JSON.stringify(out))
}

export function recorderScript(name: string) {
  return ["#!/usr/bin/env bun", recorderBody(`process.env.K2_MARKER_DIR + ${JSON.stringify("/" + name)}`), ""].join(
    "\n",
  )
}

export async function installRecorder(target: string, name: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, recorderScript(name))
  await fs.chmod(target, 0o755)
  return target
}

// K6c: a recording server at an absolute marker path, for a test that owns its own
// marker directory instead of K2_MARKER_DIR.
export async function installResponder(target: string, out: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, ["#!/usr/bin/env bun", recorderAt(out), ""].join("\n"))
  await fs.chmod(target, 0o755)
  return target
}

// K6c: installed in the managed package cache, the same place Npm.which resolves a
// real typescript-language-server from.
export async function recorderShim(pkg: string, bin: string, name = "k6-lsp-init.json") {
  return installRecorder(path.join(Global.Path.cache, "packages", pkg, "node_modules", ".bin", bin), name)
}

export async function readRecorded(markerDir: string, name: string) {
  try {
    return JSON.parse(await fs.readFile(path.join(markerDir, name), "utf8")) as Record<string, any>
  } catch {
    return undefined
  }
}
