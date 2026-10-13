import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { ProjectID } from "@opencode-ai/project/schema"
import type { SessionID } from "@opencode-ai/core/session/schema"
import { runValidatorsForCkpt, buildExtractionReflection, buildReflectionMessage } from "@opencode-ai/core/session/checkpoint-retry"
import { checkpointPath, memoryPath } from "@opencode-ai/core/session/checkpoint-paths"
import * as CheckpointContext from "@opencode-ai/core/session/checkpoint-context"

const EMPTY_CTX: CheckpointContext.CheckpointContext = {
  priorTitles: new Set<string>(),
  expectedRevisions: [],
}

export async function CheckpointSplitoverPlugin(pluginInput: PluginInput): Promise<Hooks> {
  const projectID = pluginInput.project.id as ProjectID

  return {
    "supervisor.preStop": {
      matcher: { agentType: { include: ["checkpoint-writer"] } },
      run: async (input, output) => {
        const sessionID = (input.parentSessionID ?? input.sessionID) as SessionID
        const ctx = CheckpointContext.get(sessionID, input.supervisorID) ?? EMPTY_CTX
        try {
          const violations = await runValidatorsForCkpt(sessionID, {
            priorTitles: ctx.priorTitles,
            expectedRevisions: ctx.expectedRevisions,
            projectID,
          })
          if (violations.length === 0) return

          const extractRequired = violations.filter((v) => v.severity === "extract-required")
          if (extractRequired.length > 0) {
            output.continue = true
            output.reason = buildExtractionReflection(extractRequired)
            return
          }

          const errors = violations.filter((v) => v.severity === "error")
          if (errors.length > 0) {
            output.continue = true
            output.reason = buildReflectionMessage(errors, {
              checkpoint: checkpointPath(sessionID),
              memory: memoryPath(projectID),
            })
            return
          }
          // warn-only -> fall through, leave output untouched
        } catch (err) {
          console.error("checkpoint-splitover hook failed", { err, sessionID, supervisorID: input.supervisorID })
        }
      },
    },
  }
}
