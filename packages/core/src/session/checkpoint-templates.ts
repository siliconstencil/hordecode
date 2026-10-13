export const CHECKPOINT_TEMPLATE = `Topic: <one-line summary of the session's current state>

### Execution context
_The narrative spine: the user's verbatim request (block-quoted), next concrete action, current work, files read/edited, session directives. The verbatim quote is the ground truth for what to do — do not paraphrase._

(none yet)

### Live resources
_Runtime state: branch, uncommitted files, running processes/PIDs, worktrees, servers, ports, spawned agents, open files. Most volatile — be concise._

(none yet)

### Session metadata
_Session id, model, agent mode, token threshold crossed, timestamps, derivation lineage, in-flight task IDs from the task tool._

(none yet)

### Discovered
_Cross-task learnings. Each bullet needs a "Why:" line and a "How to apply:" line. Use "(none)" if no entries._

(none)

### Dead ends
_Approaches tried and why they failed, or what to avoid. Use "(none)" if no entries._

(none)
`

export const MEMORY_TEMPLATE = `# Project memory
_Durable project-level knowledge. Persists across all sessions in this project. Edit only content under italic instructions._

## Project context
_What is this project? What's its goal? High-level identity._

(none yet)

## Rules
_Hard constraints from user that every session must respect._

(none yet)

## Architecture decisions
_Major design choices with rationale. The "why" matters more than the "what" for future sessions._

(none yet)

## Discovered durable knowledge
_Cross-task facts that survive across sessions. Promoted from session checkpoints' ### Discovered when proven durable._

(none yet)
`

/**
 * Section budgets for checkpoint.md (token estimates per section).
 * Keys follow the validator-enforced schema (checkpoint-validator.ts):
 * Topic: first line, then the five `###` sub-sections in this order.
 * Total ~6.6K, well under the 40K tail max.
 */
export const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
  "Execution context": 2000,
  "Live resources": 800,
  "Session metadata": 1000,
  "Discovered": 2000,
  "Dead ends": 800,
}

/**
 * Section budgets for MEMORY.md (project-level). Total ~10K.
 */
export const MEMORY_SECTION_BUDGETS: Record<string, number> = {
  "Project context": 1000,
  "Rules": 2000,
  "Architecture decisions": 3000,
  "Discovered durable knowledge": 4000,
}

export const NOTES_TEMPLATE = `# Session notes
_Free-form scratchpad for the main agent. Append entries as you go; the checkpoint writer reconciles them at checkpoint events. Format each entry as \`## [turn N · YYYY-MM-DDTHH:MM:SSZ]\` (minute precision UTC, seconds optional) followed by free-form body. Before appending: scan existing entries — if you've already noted substantially similar content, add a short \`(see entry above)\` reference instead of duplicating._
`
