// Ported from upstream packages/opencode/src/metrics/
// Scope: jsonByteLength + event schemas ONLY
// Excluded: client.ts, subscriber.ts, installation.ts

export { jsonByteLength } from "./metrics/util"
export { ModelCall, ToolCall, AgentRequest, TryBestDetected } from "./metrics/event"

// Metrics namespace -- consumers use Metrics.jsonByteLength(), Metrics.ModelCall, etc.
import { jsonByteLength } from "./metrics/util"
import { ModelCall, ToolCall, AgentRequest, TryBestDetected } from "./metrics/event"

export const Metrics = {
  jsonByteLength,
  ModelCall,
  ToolCall,
  AgentRequest,
  TryBestDetected,
}
