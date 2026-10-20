#!/usr/bin/env bash
# Harness Eval Score Helper
# Provides keyword-based initial scoring for pipeline stages
# Usage: ./score-helper.sh <stage> <output_log>
# Outputs suggested scores (0.0-1.0) based on keyword detection

set -e

STAGE="${1:-}"
OUTPUT="${2:-}"

if [ -z "$STAGE" ] || [ -z "$OUTPUT" ]; then
  echo "Usage: $0 <stage> <output_log>"
  echo "Stages: brainstorm plan tdd execute verify review report merge"
  exit 1
fi

if [ ! -f "$OUTPUT" ]; then
  echo "Error: output log not found: $OUTPUT"
  exit 1
fi

CONTENT=$(cat "$OUTPUT")

# Helper: count case-insensitive matches, always returns clean integer
count_matches() {
  local count
  count=$(echo "$CONTENT" | grep -ci "$1" 2>/dev/null || echo "0")
  # Strip whitespace and newlines, keep only digits
  echo "$count" | tr -cd '0-9'
}

# Keyword-based scoring. Failure and error patterns are anchored to counts and markers
# ("[1-9] fail", "exit code: [1-9]", "error:") so that a passing run's own summary
# ("0 fail", "error handling") is not read as a failure.
SCORES=""

case "$STAGE" in
  brainstorm)
    HAS_DESIGN=$(count_matches "design\|spec\|requirement\|architecture")
    HAS_USER_INTENT=$(count_matches "user.*intent\|goal\|objective")
    if [ "$HAS_DESIGN" -gt 2 ] && [ "$HAS_USER_INTENT" -gt 0 ]; then
      SCORES="completeness:0.85,user_alignment:0.80"
    else
      SCORES="completeness:0.60,user_alignment:0.50"
    fi
    ;;
  plan)
    HAS_TASKS=$(count_matches "task\|step\|phase")
    HAS_DEPS=$(count_matches "depend\|prerequisite\|blocked")
    if [ "$HAS_TASKS" -gt 3 ] && [ "$HAS_DEPS" -gt 0 ]; then
      SCORES="task_clarity:0.85,completeness:0.80"
    else
      SCORES="task_clarity:0.60,completeness:0.55"
    fi
    ;;
  tdd)
    HAS_TESTS=$(count_matches "test\|spec\|assert\|expect")
    HAS_RED=$(count_matches "[1-9][0-9]* fail\|\bRED\b\|FAIL\b\|expected.*error")
    HAS_GREEN=$(count_matches "[1-9][0-9]* pass\|0 fail\|\bGREEN\b\|success")
    if [ "$HAS_TESTS" -gt 2 ] && [ "$HAS_RED" -gt 0 ] && [ "$HAS_GREEN" -gt 0 ]; then
      SCORES="test_quality:0.85,coverage:0.80"
    else
      SCORES="test_quality:0.50,coverage:0.45"
    fi
    ;;
  execute)
    HAS_IMPL=$(count_matches "implement\|code\|function\|class")
    HAS_VERIFY=$(count_matches "verify\|test\|pass")
    HAS_ERROR=$(count_matches "error:\|[1-9][0-9]* fail\|exception\|exit code: [1-9]\|Traceback")
    if [ "$HAS_IMPL" -gt 2 ] && [ "$HAS_VERIFY" -gt 0 ] && [ "$HAS_ERROR" -eq 0 ]; then
      SCORES="completion:0.85,correctness:0.80"
    else
      SCORES="completion:0.60,correctness:0.55"
    fi
    ;;
  verify)
    HAS_PASS=$(count_matches "PASS\|[1-9][0-9]* pass\|0 fail\|exit code: 0\|exit 0")
    HAS_FAIL=$(count_matches "FAIL:\|[1-9][0-9]* fail\|error:\|exit code: [1-9]")
    HAS_EVIDENCE=$(count_matches "output\|result\|evidence")
    if [ "$HAS_PASS" -gt 0 ] && [ "$HAS_FAIL" -eq 0 ] && [ "$HAS_EVIDENCE" -gt 0 ]; then
      SCORES="freshness:0.90,completeness:0.85"
    else
      SCORES="freshness:0.50,completeness:0.45"
    fi
    ;;
  review)
    HAS_STRENGTHS=$(count_matches "strength\|good\|clean")
    HAS_ISSUES=$(count_matches "issue\|concern\|improve")
    HAS_CRITICAL=$(count_matches "[1-9][0-9]* critical\|critical:\|blocker\|must fix")
    if [ "$HAS_STRENGTHS" -gt 0 ] && [ "$HAS_CRITICAL" -eq 0 ]; then
      SCORES="thoroughness:0.85,actionability:0.80"
    else
      SCORES="thoroughness:0.60,actionability:0.55"
    fi
    ;;
  report)
    HAS_SUMMARY=$(count_matches "summary\|built\|completed\|shipped")
    HAS_METRICS=$(count_matches "metric\|score\|test.*pass\|coverage")
    if [ "$HAS_SUMMARY" -gt 0 ] && [ "$HAS_METRICS" -gt 0 ]; then
      SCORES="completeness:0.85,accuracy:0.80"
    else
      SCORES="completeness:0.60,accuracy:0.55"
    fi
    ;;
  merge)
    HAS_CLEAN=$(count_matches "clean\|pass\|success\|ready")
    HAS_CONFLICT=$(count_matches "conflict\|error:\|[1-9][0-9]* fail\|exit code: [1-9]")
    if [ "$HAS_CLEAN" -gt 0 ] && [ "$HAS_CONFLICT" -eq 0 ]; then
      SCORES="readiness:0.90,cleanliness:0.85"
    else
      SCORES="readiness:0.50,cleanliness:0.45"
    fi
    ;;
  *)
    echo "Unknown stage: $STAGE"
    exit 1
    ;;
esac

echo "Stage: $STAGE"
echo "Suggested scores (keyword-based, verify manually):"
echo "$SCORES" | tr ',' '\n'
echo ""
echo "NOTE: These are initial estimates. Adjust based on actual output quality."
echo "Use these as starting points, not final scores."

# Token estimate (chars / 4 heuristic)
CHARS=$(wc -c < "$OUTPUT" 2>/dev/null || echo "0")
EST_TOKENS=$((CHARS / 4))
echo "estimated_tokens:$EST_TOKENS"

# Budget check
BUDGETS="$(dirname "$0")/../stage-budgets.conf"
if [ -f "$BUDGETS" ]; then
  BUDGET=$(grep -E "^${STAGE}=" "$BUDGETS" | cut -d= -f2)
  if [ -n "$BUDGET" ]; then
    if [ "$EST_TOKENS" -gt $((BUDGET * 2)) ]; then
      echo "budget_status:OVERRUN(2x)"
    elif [ "$EST_TOKENS" -gt "$BUDGET" ]; then
      echo "budget_status:OVER"
    else
      echo "budget_status:OK"
    fi
  else
    echo "budget_status:NO_BUDGET"
  fi
else
  echo "budget_status:stage-budgets.conf not found"
fi
