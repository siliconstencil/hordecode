// Fake LSP server that (1) dumps its received process.env to a file, then
// (2) behaves as a minimal initialize-answering stdio server so the LSP client
// handshake completes. Used by the task credential-strip tests to observe
// the ACTUAL env object a spawn site passes to the child.
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

// Relative dump path is resolved against the child's cwd (the LSP root,
// which is the instance directory). Absolute paths are honored as-is.
const dumpPath = resolve(process.argv[2])
if (!dumpPath) {
  process.stderr.write("env-dump-server: missing dump path argv[2]\n")
  process.exit(2)
}

// Encode the received env in sorted order so the test can assert on exact keys.
const keys = Object.keys(process.env).sort()
writeFileSync(dumpPath, JSON.stringify({ keys, env: process.env }, null, 2))

let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\r\n\r\n")) !== -1) {
    const header = buf.slice(0, idx).toString()
    const len = /Content-Length:\s*(\d+)/i.exec(header)
    const bodyStart = idx + 4
    if (!len) {
      buf = buf.slice(bodyStart)
      continue
    }
    const length = parseInt(len[1], 10)
    if (buf.length < bodyStart + length) break
    const body = buf.slice(bodyStart, bodyStart + length).toString()
    buf = buf.slice(bodyStart + length)
    const msg = JSON.parse(body)
    if (msg.id !== undefined && msg.method === "initialize") {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { capabilities: { textDocumentSync: { change: 2 } } },
      })
      process.stdout.write(
        Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
      )
    }
  }
})
