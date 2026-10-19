#!/usr/bin/env bash
# research-distill.sh -- monthly distillation helper for research pipeline
# Usage: ./research-distill.sh
# Scans research/architecture/ for DRAFT docs >30 days old, lists them for triage
# Output: triage report to stdout, writes research/pipeline/distill-report.md

set -euo pipefail

REPORT="pipeline/distill-report.md"
mkdir -p "$(dirname "${REPORT}")"
ARCH_DIR="architecture"
NOW=$(date +%s)
THIRTY_DAYS=$((30 * 86400))

# Trajectory DB path for cross-referencing repeated workflows
HORDE_DB="${HORDECODE_DB:-$HOME/.local/share/hordecode/hordecode.db}"

echo "# Monthly Distillation Report" > "${REPORT}"
echo "" >> "${REPORT}"
echo "> Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${REPORT}"
echo "" >> "${REPORT}"

# Find DRAFT docs older than 30 days
echo "## Stale DRAFTs (>30 days)" >> "${REPORT}"
echo "" >> "${REPORT}"
echo "| File | Date | Age | Action |" >> "${REPORT}"
echo "|------|------|-----|--------|" >> "${REPORT}"

STALE_COUNT=0
for f in "${ARCH_DIR}"/*.md; do
  [[ -f "${f}" ]] || continue
  # Check if DRAFT
  if head -5 "${f}" | grep -qi "DRAFT"; then
    # Get file modification time
    MTIME=$(stat -c %Y "${f}" 2>/dev/null || echo "0")
    AGE=$((NOW - MTIME))
    if [[ ${AGE} -gt ${THIRTY_DAYS} ]]; then
      AGE_DAYS=$((AGE / 86400))
      BASENAME=$(basename "${f}")
      echo "| ${BASENAME} | $(date -d @${MTIME} +%Y-%m-%d) | ${AGE_DAYS}d | TRIAGE (promote/archive/extend) |" >> "${REPORT}"
      STALE_COUNT=$((STALE_COUNT + 1))
    fi
  fi
done

if [[ ${STALE_COUNT} -eq 0 ]]; then
  echo "| (none) | -- | -- | -- |" >> "${REPORT}"
fi

echo "" >> "${REPORT}"
echo "## Summary" >> "${REPORT}"
echo "- Stale DRAFTs: ${STALE_COUNT}" >> "${REPORT}"
echo "- Action needed: promote to FINAL, archive as SUPERSEDED, or extend with new deadline" >> "${REPORT}"

# List FINAL docs (no action needed)
FINAL_COUNT=$(grep -rl "FINAL" "${ARCH_DIR}"/*.md 2>/dev/null | wc -l || true)
echo "- FINAL docs: ${FINAL_COUNT}" >> "${REPORT}"

echo "" >> "${REPORT}"
echo "## Trajectory Frequency (top tool patterns)" >> "${REPORT}"
echo "" >> "${REPORT}"
echo "| Pattern | Hits | Source of truth |" >> "${REPORT}"
echo "|---------|------|-----------------|" >> "${REPORT}"

if command -v sqlite3 >/dev/null 2>&1 && [[ -f "${HORDE_DB}" ]]; then
  sqlite3 -readonly "${HORDE_DB}" -noheader -csv \
    "SELECT CASE WHEN body LIKE '%bun run typecheck%' THEN 'bun run typecheck' WHEN body LIKE '%grep%error TS%' THEN 'grep error TS' WHEN body LIKE '%git log --oneline%' THEN 'git log --oneline' WHEN body LIKE '%git diff --stat%' THEN 'git diff --stat' WHEN body LIKE '%git show%' THEN 'git show' WHEN body LIKE '%git status%' THEN 'git status' WHEN body LIKE '%sqlite3%' THEN 'sqlite3' WHEN body LIKE '%stat -c%' THEN 'stat' WHEN body LIKE '%free -%' THEN 'pre-flight(free)' WHEN body LIKE '%find% -name%' THEN 'find' ELSE 'other' END AS pattern, COUNT(*) AS hits FROM history_fts WHERE tool_name IN ('Bash','bash') GROUP BY pattern ORDER BY hits DESC LIMIT 10" \
    2>/dev/null | while IFS=, read -r desc cnt; do
      cnt=$(echo "$cnt" | tr -d '"\r')
      desc=$(echo "$desc" | tr -d '"\r')
      echo "| ${desc} | ${cnt} | hordecode.db history_fts (read-only) |" >> "${REPORT}"
    done || echo "| (sqlite3 query failed -- DB locked or sqlite3 missing) | -- | hordecode.db |" >> "${REPORT}"
else
  echo "| (sqlite3 or hordecode.db not available) | -- | hordecode.db |" >> "${REPORT}"
fi

echo "" >> "${REPORT}"
echo "## Decision Log Delta" >> "${REPORT}"
echo "" >> "${REPORT}"
echo "(Manual: list decisions made this month, new ADRs, QUEUE changes)" >> "${REPORT}"

echo "Distillation report written to ${REPORT}"
echo "Stale DRAFTs: ${STALE_COUNT}, FINAL docs: ${FINAL_COUNT}"
cat "${REPORT}"
