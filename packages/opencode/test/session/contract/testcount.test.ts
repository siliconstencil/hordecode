import { describe, expect, test } from "bun:test"
import * as TestCount from "../../../src/session/contract/testcount"

// Samples are real output captured from bun 1.4.4, go 1.24, cargo 1.97 and pytest in the dev container,
// except jest and vitest, whose summary lines are written from their documented format.
const bun = ` 1 pass
 1 skip
 1 fail
 2 expect() calls
Ran 3 tests across 1 file. [81.00ms]
`
const go = `=== RUN   TestA
--- PASS: TestA (0.00s)
=== RUN   TestB
=== RUN   TestB/sub
--- PASS: TestB (0.00s)
    --- PASS: TestB/sub (0.00s)
=== RUN   TestC
    x_test.go:5: s
--- SKIP: TestC (0.00s)
=== RUN   TestD
    x_test.go:6: no
--- FAIL: TestD (0.00s)
FAIL
FAIL	x	0.003s
FAIL
`
const goQuiet = `--- FAIL: TestD (0.00s)
    x_test.go:6: no
FAIL
FAIL	x	0.002s
FAIL
`
const cargo = `failures:
    t::d

test result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.23s

error: test failed, to rerun pass \`--lib\`
`
const pytestQuiet = `FAILED test_x.py::test_b - assert 1 == 2
1 failed, 1 passed, 1 skipped in 0.02s
`
const pytest = `FAILED test_x.py::test_b - assert 1 == 2
==================== 1 failed, 1 passed, 1 skipped in 0.01s ====================
`
const jest = `Tests:       1 failed, 1 skipped, 3 passed, 5 total
Snapshots:   0 total
Time:        1.2 s
`
const vitest = `   Test Files  1 failed | 1 passed (2)
        Tests  1 failed | 3 passed (4)
`

describe("test count parser", () => {
  test("bun test: Ran N tests is the run count, N pass the passed count", () => {
    expect(TestCount.parse(bun)).toEqual({ tool: "bun", run: 3, passed: 1 })
  })

  test("go test -v: every --- PASS/FAIL/SKIP line, nested ones included", () => {
    expect(TestCount.parse(go)).toEqual({ tool: "go", run: 5, passed: 3 })
  })

  test("go test without -v prints only the failing tests, so it is not parseable", () => {
    expect(TestCount.parse(goQuiet)).toBeUndefined()
  })

  test("cargo test: summed over every test result line", () => {
    expect(TestCount.parse(cargo)).toEqual({ tool: "cargo", run: 4, passed: 2 })
    expect(TestCount.parse(`${cargo}\ntest result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s`)).toEqual({
      tool: "cargo",
      run: 8,
      passed: 5,
    })
  })

  test("pytest: quiet and verbose summary lines, skipped counts as run", () => {
    expect(TestCount.parse(pytestQuiet)).toEqual({ tool: "pytest", run: 3, passed: 1 })
    expect(TestCount.parse(pytest)).toEqual({ tool: "pytest", run: 3, passed: 1 })
    expect(TestCount.parse("no tests ran in 0.01s")).toEqual({ tool: "pytest", run: 0, passed: 0 })
    expect(TestCount.parse("===== 2 passed, 1 error in 0.1s =====")).toEqual({ tool: "pytest", run: 3, passed: 2 })
  })

  test("jest and vitest summary lines", () => {
    expect(TestCount.parse(jest)).toEqual({ tool: "jest", run: 5, passed: 3 })
    expect(TestCount.parse(vitest)).toEqual({ tool: "vitest", run: 4, passed: 3 })
    expect(TestCount.parse("      Tests  4 passed (4)")).toEqual({ tool: "vitest", run: 4, passed: 4 })
  })

  test("zero tests is parsed as zero, not as unparseable", () => {
    expect(TestCount.parse("Ran 0 tests across 0 files. [1.00ms]\n 0 pass\n")).toEqual({ tool: "bun", run: 0, passed: 0 })
    expect(TestCount.parse("Tests:       0 total")).toEqual({ tool: "jest", run: 0, passed: 0 })
  })

  test("unrelated or empty output is not parseable", () => {
    expect(TestCount.parse("")).toBeUndefined()
    expect(TestCount.parse("all good\nbuilt in 3s")).toBeUndefined()
    expect(TestCount.parse("process exited early")).toBeUndefined()
  })

  test("truncated output: the tail-summary formats still parse, the summed formats (go, cargo) do not", () => {
    expect(TestCount.parse(bun, true)).toEqual({ tool: "bun", run: 3, passed: 1 })
    expect(TestCount.parse(pytest, true)?.run).toBe(3)
    expect(TestCount.parse(go, true)).toBeUndefined()
    expect(TestCount.parse(cargo, true)).toBeUndefined()
  })

  test("a bun run cut short by process.exit prints no summary", () => {
    expect(TestCount.parse("error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n\n(fail) y [0.10ms]\n")).toBeUndefined()
  })
})
