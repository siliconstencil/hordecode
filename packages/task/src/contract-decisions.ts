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
  /** 3. Default of the contract-level unattended flag (`;; unattended` in the spec). false: every criterion run asks the permission system. true: the criteria are approved once at arm time and runs only honor explicit deny rules. */
  unattended: false as boolean,
  /** 8. Create the lightweight ref refs/hordecode/contract/<session> at HEAD when a contract is armed. Never a commit or stash. */
  checkpointRef: false as boolean,
  /** 5. "all-test-files": every test file in the project plus named paths. "named-only": only paths named in the contract. */
  protect: "all-test-files" as "all-test-files" | "named-only",
  /** 5. A new test file after arm time is ignored (true) or an integrity violation (false). Modified and deleted protected files always fail. */
  allowAddedTests: true,
  /** 5. Also protect the test, pretest and posttest scripts of every package.json and the scripts they reach (mode "all-test-files" only). */
  protectScripts: true,
  /** 5. Also protect the common runner configs (bunfig.toml, jest/vitest config, pytest.ini, conftest.py, tox.ini, setup.cfg, pyproject.toml, go.mod, Cargo.toml) when present; one added later is a violation (mode "all-test-files" only). */
  protectRunnerConfigs: true,
  /** At arm time run each criterion once and record the test count of a recognized summary; a later run with fewer tests, none, or an unreadable summary fails the criterion. */
  testBaseline: true,
  /** Integrity violation: "fail" ends the contract as failed; "reenter" nudges like a failed criterion. */
  onIntegrityViolation: "fail" as "fail" | "reenter",
  /** 6. Cap on stop-gate re-entries before the contract becomes blocked. */
  maxReact: 3,
  /** 6. Wall-time limit of one criterion run. A timeout is a failed criterion. */
  criterionTimeoutMs: 120_000,
  /** 6. Safety envelope; 0 = off. A breach ends the contract as blocked with the breach recorded as evidence. */
  maxWallMs: 0 as number,
  maxToolCalls: 0 as number,
  maxCostUsd: 0 as number,
  /** Cap on protected files hashed at arm time; arming fails above it. */
  maxProtectedFiles: 5000,
  /** Bytes of output kept per run for the log and the re-entry text. */
  outputTailBytes: 16_384,
  /** Characters of output quoted in a re-entry turn. */
  reentryTailChars: 2000,
  /** 9. Report delivery: a file under the data directory, outside the project tree. */
  reportDir: "contracts",
} as const
