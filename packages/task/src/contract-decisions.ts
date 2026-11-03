/**
 * Owner decisions for the task contract slice. Each value is the most conservative option; flip
 * the value here, nothing else reads a literal. Numbers are the open-decision numbers of the
 * design note.
 */
export const CONTRACT_DECISIONS = {
  /** 1. Where the record lives. Only "session" (process memory, not agent-editable) is implemented. */
  storage: "session",
  /** 2. Where criteria run. Only "session-directory" is implemented. */
  criteriaCwd: "session-directory",
  /** 3. "ask-each-run": every criterion run goes through the permission system. "trust-once-armed": one permission ask at arm time, none per run. */
  criteriaPermission: "ask-each-run" as "ask-each-run" | "trust-once-armed",
  /** 5. "all-test-files": every test file in the project plus named paths. "named-only": only paths named in the contract. */
  protect: "all-test-files" as "all-test-files" | "named-only",
  /** 5. A new test file after arm time is an integrity violation when false. */
  allowAddedTests: false,
  /** Integrity violation: "fail" ends the contract as failed; "reenter" nudges like a failed criterion. */
  onIntegrityViolation: "fail" as "fail" | "reenter",
  /** 6. Cap on stop-gate re-entries before the contract becomes blocked. */
  maxReact: 3,
  /** 6. Wall-time limit of one criterion run. A timeout is a failed criterion. */
  criterionTimeoutMs: 120_000,
  /** Cap on protected files hashed at arm time; arming fails above it. */
  maxProtectedFiles: 5000,
  /** Bytes of output kept per run for the log and the re-entry text. */
  outputTailBytes: 16_384,
  /** Characters of output quoted in a re-entry turn. */
  reentryTailChars: 2000,
  /** 9. Report delivery: a file under the data directory, outside the project tree. */
  reportDir: "contracts",
} as const
