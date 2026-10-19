#!/usr/bin/env bash
# Harness Eval Aggregator
# Reads all eval JSON files and produces aggregate statistics
# Usage: ./aggregate.sh [eval_dir]
# Default eval_dir: docs/harness/eval/

set -e

# Dependency check
for cmd in jq bc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found. Install it first."
    exit 1
  fi
done

EVAL_DIR="${1:-docs/harness/eval}"

# Unique temp files to avoid race condition when multiple instances run
UNIQUE_ID="$$_$(date +%s)"
STAGES_TMP="/tmp/harness_eval_stages_${UNIQUE_ID}.txt"
FAILURES_TMP="/tmp/harness_eval_failures_${UNIQUE_ID}.txt"
trap 'rm -f "$STAGES_TMP" "$FAILURES_TMP"' EXIT

if [ ! -d "$EVAL_DIR" ]; then
  echo "Error: Eval directory not found: $EVAL_DIR"
  echo "Usage: $0 [eval_dir]"
  exit 1
fi

JSON_FILES=$(find "$EVAL_DIR" -name "*.json" -type f 2>/dev/null | sort)

if [ -z "$JSON_FILES" ]; then
  echo "No eval JSON files found in $EVAL_DIR"
  exit 0
fi

TOTAL=$(echo "$JSON_FILES" | wc -l | tr -d ' ')
echo "=== Harness Eval Aggregate Report ==="
echo "Eval files found: $TOTAL"
echo ""

# Count pass/fail/warn
PASS=0
WARN=0
FAIL=0
TOTAL_SCORE=0
SCORE_COUNT=0

# Per-stage accumulators
declare -A STAGE_COUNT
declare -A STAGE_SCORE_SUM

# Failure type counter
declare -A FAILURE_TYPES

for f in $JSON_FILES; do
  # Extract overall score and pass/fail
  SCORE=$(jq -r '.overall_score // 0' "$f" 2>/dev/null || echo "0")
  IS_PASS=$(jq -r '.pass // false' "$f" 2>/dev/null || echo "false")
  FAILURES=$(jq -r '.failures | length' "$f" 2>/dev/null || echo "0")
  CRITICAL=$(jq -r '[.failures[] | select(.severity == "critical")] | length' "$f" 2>/dev/null || echo "0")

  if [ "$IS_PASS" = "true" ] && [ "$CRITICAL" = "0" ]; then
    PASS=$((PASS + 1))
  elif [ "$SCORE" != "0" ]; then
    WARN=$((WARN + 1))
  else
    FAIL=$((FAIL + 1))
  fi

  if [ "$SCORE" != "0" ]; then
    TOTAL_SCORE=$(echo "$TOTAL_SCORE + $SCORE" | bc 2>/dev/null || echo "$TOTAL_SCORE")
    SCORE_COUNT=$((SCORE_COUNT + 1))
  fi

  # Per-stage scores
  jq -r '.stages[] | "\(.stage) \(.scores | to_entries | map(.value) | add / length)"' "$f" 2>/dev/null | while read -r STAGE AVG; do
    echo "$STAGE $AVG" >> "$STAGES_TMP"
  done

  # Failure types
  jq -r '.failures[] | .failure_type' "$f" 2>/dev/null | while read -r FT; do
    echo "$FT" >> "$FAILURES_TMP"
  done
done

echo "--- Summary ---"
echo "PASS: $PASS"
echo "WARN: $WARN"
echo "FAIL: $FAIL"

if [ "$SCORE_COUNT" -gt 0 ]; then
  AVG_SCORE=$(echo "scale=2; $TOTAL_SCORE / $SCORE_COUNT" | bc 2>/dev/null || echo "N/A")
  echo "Average Score: $AVG_SCORE"
fi

echo ""
echo "--- Per-Stage Average Scores ---"
if [ -f "$STAGES_TMP" ]; then
  sort "$STAGES_TMP" | awk '{
    sum[$1] += $2
    count[$1]++
  } END {
    for (stage in sum) {
      printf "%-30s %.2f (n=%d)\n", stage, sum[stage]/count[stage], count[stage]
    }
  }' | sort -t'=' -k2 -rn
fi

echo ""
echo "--- Failure Type Distribution ---"
if [ -f "$FAILURES_TMP" ]; then
  sort "$FAILURES_TMP" | uniq -c | sort -rn
else
  echo "No failures recorded"
fi

echo ""
echo "--- Pattern Detection ---"
if [ -f "$FAILURES_TMP" ]; then
  echo "(check SUMMARY.md for flagged patterns)"
fi

echo ""
echo "=== End Report ==="
