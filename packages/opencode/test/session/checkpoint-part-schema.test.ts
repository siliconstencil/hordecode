import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

// Regression: a CheckpointPart-shaped object must round-trip through the
// authoritative runtime Part schema (SessionV1.Part). Before the fix the schema
// package's Part union omitted CheckpointPart, so rebuilding a session from a
// checkpoint threw SchemaError("Expected Part, got {type:checkpoint...}") and the
// prompt failed outright (opencode/src/session/prompt.ts decodeMessagePart).
const checkpointPart = {
  id: "prt_checkpoint1",
  sessionID: "ses_checkpoint1",
  messageID: "msg_checkpoint1",
  type: "checkpoint",
  checkpointDir: "",
  checkpointNumber: 0,
  coveredUpTo: "msg_boundary1",
}

const decodePart = Schema.decodeUnknownExit(SessionV1.Part)

describe("CheckpointPart round-trips through SessionV1.Part", () => {
  it("decodes a checkpoint part without throwing", () => {
    const decoded = Effect.runSync(decodePart(checkpointPart)) as {
      type: string
      coveredUpTo: string
    }
    expect(decoded.type).toBe("checkpoint")
    expect(decoded.coveredUpTo).toBe("msg_boundary1")
  })

  it("rejects a structurally invalid checkpoint part", () => {
    expect(() =>
      Effect.runSync(
        decodePart({ ...checkpointPart, checkpointNumber: "zero" } as unknown as typeof checkpointPart),
      ),
    ).toThrow()
  })
})
