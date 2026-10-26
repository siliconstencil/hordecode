import path from "path"
import { Effect } from "effect"
import type { Agent } from "@opencode-ai/agent/agent"
import type { InstanceContext } from "@opencode-ai/project/instance"
import { modeSkillsBlock } from "@opencode-ai/skill/harness/extract"
import type { Config } from "../config/index"
import { resolveDocsDir } from "../config/harness"
import type { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import PROMPT_HARNESS from "./prompt/harness.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"

/**
 * Mode-driven skill pipeline injection: when the session agent has a
 * `skillPipeline` field (e.g. "harness", "research"), inject the
 * corresponding mode prompt with its skills block into the latest user
 * message. Lives in its own module so the opencode session loop can import it
 * without loading the whole core session prompt graph.
 */
const MODE_PROMPTS: Record<string, string> = {
  harness: PROMPT_HARNESS,
  research: PROMPT_RESEARCH,
}

export const applyHarnessInjection = Effect.fn("SessionPrompt.applyHarnessInjection")(function* (
  msgs: MessageV2.WithParts[],
  agent: Agent.Info,
  cfg: Config.Info,
  ctx: InstanceContext,
) {
  const pipeline = agent.skillPipeline
  if (!pipeline) return

  const userMsg = msgs.findLast((msg) => msg.info.role === "user")
  if (!userMsg) return

  const promptText = MODE_PROMPTS[pipeline]
  if (!promptText) return

  const skillsBlock = modeSkillsBlock(pipeline)
  const harnessCfg = cfg.harness
  const docsDir = resolveDocsDir(ctx.worktree, harnessCfg)
  const text = promptText
    .replace("{{harness_skills}}", skillsBlock)
    .replace("{{harness_docs_dir}}", `Save ${pipeline} skill outputs: specs in \`${path.join(docsDir, "specs")}\`, plans in \`${path.join(docsDir, "plans")}\`, reports in \`${path.join(docsDir, "reports")}\`.`)
  userMsg.parts.unshift({
    id: PartID.ascending(),
    messageID: userMsg.info.id,
    sessionID: userMsg.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
})
