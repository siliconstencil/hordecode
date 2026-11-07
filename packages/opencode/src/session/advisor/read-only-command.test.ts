import { describe, expect, test } from "bun:test"
import { isReadOnlyCommand } from "./read-only-command"

describe("isReadOnlyCommand", () => {
  const allowed = [
    "sed -n '1,40p' file.ts",
    "rg foo packages",
    "grep -rn foo packages",
    "ls packages",
    "git log --oneline -5",
    "git show HEAD:file.ts",
    "git diff --stat",
    "git status --short",
    "sqlite3 -readonly db.sqlite 'select 1'",
    "wc -l file.ts",
    "head -20 file.ts",
    "tail -20 file.ts",
    "cat file.ts",
    "rg foo packages | head -20",
    "git log --oneline | wc -l",
    "ls && git status --short",
  ]
  for (const command of allowed) {
    test(`read-only: ${command}`, () => expect(isReadOnlyCommand(command)).toBe(true))
  }

  const rejected = [
    "",
    "echo hi > file.ts",
    "rg foo > out.txt",
    "rg foo >> out.txt",
    "cat file.ts 2>/dev/null",
    "rg foo | tee out.txt",
    "rg foo | xargs rm",
    "sed -i 's/a/b/' file.ts",
    "sed 's/a/b/' file.ts",
    "rg -i foo",
    "git commit -m x",
    "git checkout main",
    "sqlite3 db.sqlite 'select 1'",
    "rm file.ts",
    "npm install",
    "cd packages && git log",
    "bash -c 'ls'",
    "cat $(ls)",
    "cat `echo file`",
  ]
  for (const command of rejected) {
    test(`not read-only: ${command}`, () => expect(isReadOnlyCommand(command)).toBe(false))
  }
})
