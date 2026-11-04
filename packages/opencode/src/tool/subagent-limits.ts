// The limit rule lives in the supervisor package so every spawn path (supervisor tool, session
// create/ask, workflow agent) can share it. Re-exported here for the existing opencode importers.
export * from "@opencode-ai/supervisor/limits"
