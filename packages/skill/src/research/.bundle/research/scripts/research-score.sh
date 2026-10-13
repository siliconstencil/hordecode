#!/usr/bin/env bash
# research-score.sh -- keyword-based per-phase scoring for research runs
# Usage: ./research-score.sh <run-id> <phase>
# Output: phase score 0.0-1.0 to stdout (also writes to findings/<run-id>/<phase>.score)
# Scoring: keyword presence weighted by count, normalized to 0.0-1.0

set -euo pipefail

RUN_ID="${1:?Usage: research-score.sh <run-id> <phase>}"
PHASE="${2:?Usage: research-score.sh <run-id> <phase>}"
FINDINGS_DIR="findings/${RUN_ID}"
EVIDENCE_FILE="${FINDINGS_DIR}/${PHASE}.evidence"
SCORE_FILE="${FINDINGS_DIR}/${PHASE}.score"

if [[ ! -f "${EVIDENCE_FILE}" ]]; then
  echo "ERROR: evidence file not found: ${EVIDENCE_FILE}" >&2
  exit 1
fi

CONTENT=$(cat "${EVIDENCE_FILE}")

# Keyword sets per phase (pipe-separated, case-insensitive grep)
case "${PHASE}" in
  scope)
    KEYWORDS="research question|scope boundary|evidence policy|success criteria|perspective|assumption|risk"
    MIN_HITS=3
    ;;
  gather)
    KEYWORDS="source|url|arxiv|doi|http|citation|verif|confidence|conflict"
    MIN_HITS=4
    ;;
  verify)
    KEYWORDS="citation.*exist|uncorroborated|source.*reliab|conflict|freshness|cross.*ref"
    MIN_HITS=3
    ;;
  filter)
    KEYWORDS="source|confidence|flag|token.*budget|compressed|dedup|merge"
    MIN_HITS=3
    ;;
  synthesize)
    KEYWORDS="executive summary|finding|gap analysis|recommendation|citation table|source"
    MIN_HITS=4
    ;;
  decide)
    KEYWORDS="ADOPT\|DEFER\|REJECT|reasoning|evidence|milestone|ADR|decision"
    MIN_HITS=3
    ;;
  eval)
    KEYWORDS="metric|score|source.*count|claim.*trace|uncorroborated.*rate|conflict|token|wall.clock"
    MIN_HITS=3
    ;;
  *)
    echo "ERROR: unknown phase '${PHASE}'" >&2
    exit 2
    ;;
esac

# Count keyword hits
HITS=0
IFS='|' read -ra KW_ARRAY <<< "${KEYWORDS}"
for kw in "${KW_ARRAY[@]}"; do
  COUNT=$(echo "${CONTENT}" | grep -ci "${kw}" || true)
  HITS=$((HITS + COUNT))
done

# Normalize: hits / (min_hits * 3) capped at 1.0
DENOM=$((MIN_HITS * 3))
if [[ ${DENOM} -eq 0 ]]; then
  SCORE="1.0"
else
  RAW=$(echo "scale=2; ${HITS} / ${DENOM}" | bc)
  # Cap at 1.0
  SCORE=$(echo "${RAW}" | awk '{if ($1 > 1.0) print "1.0"; else print $1}')
fi

# Write score file
echo "${SCORE}" > "${SCORE_FILE}"

# Output
echo "${SCORE}"
