// Re-export orchestrator.txt as a default string for cross-package consumption.
// Agent package imports this via @opencode-ai/core/session/prompt/orchestrator.
import text from "./orchestrator.txt"
export default text
