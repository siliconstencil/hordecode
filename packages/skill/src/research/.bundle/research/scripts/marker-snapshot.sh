#!/usr/bin/env bash
# marker-snapshot.sh -- snapshot + verify glossary/handoff markers (S4 GAP-FIX survival pattern)
# Usage: ./marker-snapshot.sh snapshot   -> writes .marker-snapshot to repo root
#        ./marker-snapshot.sh verify    -> checks current counts >= snapshot, exit 1 on regression
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SNAP_FILE="${REPO_ROOT}/.marker-snapshot"
snapshot() {
  local deep handoff deliberate grill
  deep=$(grep -R "Deep-Module\|deep-module\|glossary" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  handoff=$(grep -R "handoff.*redaction\|redaction.*checklist" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  deliberate=$(grep -R "deliberate trigger\|seqthink-evidence" --include="*.sh" "${REPO_ROOT}/research/pipeline/scripts" 2>/dev/null | wc -l || echo 0)
  grill=$(grep -R "CONFIRMED:" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  cat > "${SNAP_FILE}" <<EOF
deep=${deep}
handoff=${handoff}
deliberate=${deliberate}
grill=${grill}
EOF
  echo "snapshot written to ${SNAP_FILE}: deep=${deep} handoff=${handoff} deliberate=${deliberate} grill=${grill}"
}
verify() {
  if [[ ! -f "${SNAP_FILE}" ]]; then
    echo "WARN: no snapshot found at ${SNAP_FILE}, run snapshot first" >&2
    exit 0
  fi
  # shellcheck disable=SC1090
  source "${SNAP_FILE}"
  local cur_deep cur_handoff cur_deliberate cur_grill
  cur_deep=$(grep -R "Deep-Module\|deep-module\|glossary" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  cur_handoff=$(grep -R "handoff.*redaction\|redaction.*checklist" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  cur_deliberate=$(grep -R "deliberate trigger\|seqthink-evidence" --include="*.sh" "${REPO_ROOT}/research/pipeline/scripts" 2>/dev/null | wc -l || echo 0)
  cur_grill=$(grep -R "CONFIRMED:" --include="*.md" "${REPO_ROOT}/research/pipeline/templates" 2>/dev/null | wc -l || echo 0)
  local fail=0
  if [[ ${cur_deep} -lt ${deep} ]]; then echo "FAIL: deep-module marker regressed ${deep} -> ${cur_deep}" >&2; fail=1; fi
  if [[ ${cur_handoff} -lt ${handoff} ]]; then echo "FAIL: handoff marker regressed ${handoff} -> ${cur_handoff}" >&2; fail=1; fi
  if [[ ${cur_deliberate} -lt ${deliberate} ]]; then echo "FAIL: deliberate marker regressed ${deliberate} -> ${cur_deliberate}" >&2; fail=1; fi
  if [[ ${cur_grill} -lt ${grill} ]]; then echo "FAIL: grill CONFIRMED marker regressed ${grill} -> ${cur_grill}" >&2; fail=1; fi
  if [[ ${fail} -eq 1 ]]; then exit 1; fi
  echo "PASS: markers non-regressed (deep=${cur_deep} handoff=${cur_handoff} deliberate=${cur_deliberate} grill=${cur_grill})"
}
case "${1:-}" in snapshot) snapshot;; verify) verify;; *) echo "Usage: $0 snapshot|verify" >&2; exit 2;; esac
