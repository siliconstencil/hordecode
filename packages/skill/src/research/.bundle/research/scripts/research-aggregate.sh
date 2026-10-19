#!/usr/bin/env bash
# research-aggregate.sh -- run-level score aggregation for research runs
# Usage: ./research-aggregate.sh <run-id>
# Reads all <phase>.score files in findings/<run-id>/, computes average + min + gate status
# Output: summary to stdout, writes findings/<run-id>/aggregate.json

set -euo pipefail

RUN_ID="${1:?Usage: research-aggregate.sh <run-id>}"
FINDINGS_DIR="findings/${RUN_ID}"

if [[ ! -d "${FINDINGS_DIR}" ]]; then
  echo "ERROR: findings directory not found: ${FINDINGS_DIR}" >&2
  exit 1
fi

PHASES="scope gather verify filter synthesize decide eval"
TOTAL=0
COUNT=0
MIN="1.0"
MIN_PHASE=""
ALL_PASS=true

for PHASE in ${PHASES}; do
  SCORE_FILE="${FINDINGS_DIR}/${PHASE}.score"
  if [[ ! -f "${SCORE_FILE}" ]]; then
    echo "WARN: no score for phase '${PHASE}' (skipping)" >&2
    continue
  fi
  SCORE=$(cat "${SCORE_FILE}")
  TOTAL=$(echo "scale=2; ${TOTAL} + ${SCORE}" | bc)
  COUNT=$((COUNT + 1))

  # Track minimum
  IS_LOWER=$(echo "${SCORE} < ${MIN}" | bc || true)
  if [[ ${IS_LOWER} -eq 1 ]]; then
    MIN="${SCORE}"
    MIN_PHASE="${PHASE}"
  fi

  # Check phase gate (score < 0.3 = fail)
  IS_LOW=$(echo "${SCORE} < 0.3" | bc || true)
  if [[ ${IS_LOW} -eq 1 ]]; then
    ALL_PASS=false
  fi
done

# Compute average
if [[ ${COUNT} -gt 0 ]]; then
  AVG=$(echo "scale=2; ${TOTAL} / ${COUNT}" | bc)
else
  AVG="0.0"
fi

# Gate status
if [[ "${ALL_PASS}" == "true" ]] && [[ ${COUNT} -gt 0 ]]; then
  GATE="PASS"
else
  GATE="FAIL"
fi

# Write aggregate JSON
cat > "${FINDINGS_DIR}/aggregate.json" << EOF
{
  "run_id": "${RUN_ID}",
  "phases_scored": ${COUNT},
  "average_score": ${AVG},
  "min_score": ${MIN},
  "min_phase": "${MIN_PHASE}",
  "gate": "${GATE}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Output summary
echo "Run ${RUN_ID}: avg=${AVG} min=${MIN} (${MIN_PHASE}) gate=${GATE} phases=${COUNT}/7"
