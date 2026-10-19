#!/usr/bin/env bash
# research-budget-check.sh -- mechanical enforcement of conf/phase-budgets.conf (research skill bundle)
# Until now phase-budgets.conf was documentation only -- nothing read it. This script closes
# that gap the same way harness-gate.sh closed the equivalent gap for harness (2026-07-31).
#
# Two checks:
#   1. Phase-level: findings/<run-id>/<phase>.evidence word count vs phase-budgets.conf cap.
#   2. Sub-agent-level (GATHER only): each gather_agents[].budget declared in manifest.yaml
#      (format "Nmin / NK") vs the word count of that agent's own evidence-<id>.md file.
#
# Usage: ./research-budget-check.sh <run-id> [phase]
#   phase omitted -> check all phases that have an evidence file, plus all gather sub-agents.
# Exit 0 = all checks within budget. Exit 1 = at least one over budget (does not delete anything,
# just reports -- budget overrun is a signal to compress/refocus, not an automatic failure of the
# phase itself; research-gate.sh's own content checks remain the hard pass/fail gate).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_DIR="$(dirname "${SCRIPT_DIR}")"
CONF_FILE="${PIPELINE_DIR}/conf/phase-budgets.conf"

RUN_ID="${1:?Usage: research-budget-check.sh <run-id> [phase]}"
PHASE_FILTER="${2:-}"
FINDINGS_DIR="findings/${RUN_ID}"
MANIFEST="${FINDINGS_DIR}/manifest.yaml"

if [[ ! -f "${CONF_FILE}" ]]; then
  echo "ERROR: budget conf not found: ${CONF_FILE}" >&2
  exit 2
fi

STATUS_FILE="$(mktemp)"
echo 0 > "${STATUS_FILE}"
trap 'rm -f "${STATUS_FILE}"' EXIT

echo "=== Phase-level budgets (${CONF_FILE}) ==="
while read -r PHASE TIME_MIN TOKEN_MAX; do
  [[ "${PHASE}" =~ ^#.*$ || -z "${PHASE}" ]] && continue
  [[ -n "${PHASE_FILTER}" && "${PHASE}" != "${PHASE_FILTER}" ]] && continue
  EVIDENCE_FILE="${FINDINGS_DIR}/${PHASE}.evidence"
  if [[ ! -f "${EVIDENCE_FILE}" ]]; then
    continue  # phase hasn't run yet -- not a budget violation, just nothing to check
  fi
  WORDS=$(wc -w < "${EVIDENCE_FILE}")
  if [[ ${WORDS} -gt ${TOKEN_MAX} ]]; then
    echo "OVER BUDGET: ${PHASE} -- ${WORDS} words > ${TOKEN_MAX} cap (${EVIDENCE_FILE})" >&2
    echo 1 > "${STATUS_FILE}"
  else
    echo "OK: ${PHASE} -- ${WORDS}/${TOKEN_MAX} words"
  fi
done < "${CONF_FILE}"

if [[ -f "${MANIFEST}" ]] && command -v python3 >/dev/null 2>&1; then
  echo
  echo "=== Sub-agent budgets (${MANIFEST} gather_agents[].budget) ==="
  while read -r AGENT_ID CAP; do
    [[ -z "${AGENT_ID}" ]] && continue
    EVFILE="${FINDINGS_DIR}/evidence-${AGENT_ID}.md"
    if [[ ! -f "${EVFILE}" ]]; then
      echo "SKIP: ${AGENT_ID} -- no evidence-${AGENT_ID}.md yet"
      continue
    fi
    WORDS=$(wc -w < "${EVFILE}")
    if [[ ${WORDS} -gt ${CAP} ]]; then
      echo "OVER BUDGET: ${AGENT_ID} -- ${WORDS} words > ${CAP} cap (${EVFILE})" >&2
      echo 1 > "${STATUS_FILE}"
    else
      echo "OK: ${AGENT_ID} -- ${WORDS}/${CAP} words"
    fi
  done < <(python3 - "$MANIFEST" <<'PYEOF'
import re, sys
manifest_path = sys.argv[1]
with open(manifest_path) as f:
    text = f.read()
agents = re.findall(r'-\s*id:\s*(\S+).*?budget:\s*(\d+)min\s*/\s*(\d+)K', text, re.DOTALL)
for agent_id, time_min, token_k in agents:
    print(f"{agent_id} {int(token_k)*1000}")
PYEOF
)
fi

echo
OVER_BUDGET="$(cat "${STATUS_FILE}")"
if [[ "${OVER_BUDGET}" -eq 1 ]]; then
  echo "RESULT: one or more phases/agents exceeded budget -- compress before SYNTHESIZE, don't just proceed." >&2
  exit 1
fi
echo "RESULT: all checked phases/agents within budget"
exit 0
