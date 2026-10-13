// The core test preload (test/preload.ts) forces OPENCODE_DB=":memory:", but
// the legacy sync layer (storage/db.ts) opens its own raw connection -- two
// :memory: connections are two separate databases. This module MUST be the
// first import of any test using the legacy session stack: storage/db.ts
// evaluates its Path IIFE at import time, so the shared file path must be set
// before that module graph loads. session.create() mints unique slugs, so a
// shared file does not collide across tests.
import { join } from "path"
import { tmpdir } from "os"

// HORDECODE_DB takes precedence over OPENCODE_DB in storage/db.ts's Path IIFE
// (storage/db.ts:36-44) and pins the legacy storage client to the same file
// the v2 Database layer opens via OPENCODE_DB. Both env vars are set so the
// two worlds share one database regardless of resolution order.
//
// NOTE: this test file MUST run in a fresh worker (bun test --no-worker, or a
// worker that has not yet imported storage/db.ts). storage/db.ts's Path is a
// frozen module-level IIFE: if an earlier test file in the same process
// imported it with the preload's OPENCODE_DB=":memory:", the legacy storage
// client stays pinned to :memory: and the sync layer writes to a different
// (unmigrated) database than the v2 layer reads.
//
// GATE (default-suite green): the try-best tests are gated behind
// HORDECODE_RUN_TRY_BEST_TESTS=1 (processor-try-best.test.ts uses describe.skipIf
// and packages/core has a test:try-best script that sets it). When the flag
// is unset -- the default `bun test` run -- this module must not touch
// process.env: the shared worker relies on the preload's OPENCODE_DB=":memory:"
// and mutating it here would leak a file-backed path into every later test.
if (process.env.HORDECODE_RUN_TRY_BEST_TESTS === "1") {
  const dbFile = join(tmpdir(), `hordecode-p0-2-processor-${process.pid}.db`)
  process.env.OPENCODE_DB = dbFile
  process.env.HORDECODE_DB = dbFile
  // The config loader reads module-level Global.Path.config (global.ts:23,
  // config.ts:595-601) which ignores HORDECODE_CONFIG_DIR; HORDECODE_HOME redirects
  // every global path (config/data/cache/state) into a throwaway dir so the real
  // ~/.config/hordecode/ files are never parsed against the fork schema. Must be
  // set before global.ts is imported.
  process.env.HORDECODE_HOME = join(tmpdir(), "hordecode-p0-2-home")
}
