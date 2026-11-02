import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// Worktrees are created under the global data directory; keep it out of the developer's real home.
process.env.HORDECODE_HOME = mkdtempSync(path.join(process.env.HORDECODE_TEST_TMP || tmpdir(), "worktree-test-home-"))
