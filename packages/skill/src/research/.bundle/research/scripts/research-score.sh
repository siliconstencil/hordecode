#!/usr/bin/env bash
# research-score.sh -- per-phase scoring for research runs
# Usage: ./research-score.sh <run-id> <phase>
# Output: phase score 0.0-1.0 on stdout (also written to findings/<run-id>/<phase>.score).
#         The per-check breakdown goes to stderr so the caller sees what to improve.
#
# Scores measure the artifact's structure, as scoring-metrics.conf defines it: source table
# rows, claim rows that cite a source, UNCORROBORATED checkboxes, numbered research questions,
# recorded metric keys, URL domain diversity. Each phase is scored on its gate evidence file
# together with the deliverable the phase writes (scope: brief.md, gather: evidence-*.md,
# verify: verified-evidence.md, filter: filtered-evidence.md, synthesize: report.md,
# decide: decision.md, eval: metrics.md), because the deliverable is where the structure lives.
# Vocabulary counts as one bounded check per phase: repeating a word, or appending a block of
# expected words, cannot lift a score past that check's share of the phase.

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

# The scored text: the phase's gate evidence plus its deliverable(s), when present.
case "${PHASE}" in
  scope) DELIVERABLES=("${FINDINGS_DIR}/brief.md") ;;
  gather) DELIVERABLES=("${FINDINGS_DIR}"/evidence-*.md) ;;
  verify) DELIVERABLES=("${FINDINGS_DIR}/verified-evidence.md") ;;
  filter) DELIVERABLES=("${FINDINGS_DIR}/filtered-evidence.md") ;;
  synthesize) DELIVERABLES=("${FINDINGS_DIR}/report.md") ;;
  decide) DELIVERABLES=("${FINDINGS_DIR}/decision.md") ;;
  eval) DELIVERABLES=("${FINDINGS_DIR}/metrics.md") ;;
  *) DELIVERABLES=() ;;
esac
INPUT_FILE=$(mktemp)
trap 'rm -f "${INPUT_FILE}"' EXIT
cat "${EVIDENCE_FILE}" > "${INPUT_FILE}"
SCORED="${PHASE}.evidence"
for d in "${DELIVERABLES[@]}"; do
  [[ -f "${d}" ]] || continue
  printf '\n' >> "${INPUT_FILE}"
  cat "${d}" >> "${INPUT_FILE}"
  SCORED="${SCORED} + $(basename "${d}")"
done

# ---- helpers ------------------------------------------------------------------------------

# Distinct data rows of the markdown tables under every level-2+ heading matching the regex
# (case-insensitive): the header row and the |---| separator are dropped, a section ends at
# the next heading. Level-1 titles ("# Evidence -- decide") are not sections.
section_rows() {
  awk -v re="$1" '
    BEGIN { IGNORECASE = 1; on = 0; n = 0 }
    /^#+ / { on = ($0 ~ /^##+ / && $0 ~ re) ? 1 : 0; n = 0; next }
    on && /^\|/ { if ($0 ~ /^\|[ :|-]+$/) next; n++; if (n == 1) next; print }
  ' "${INPUT_FILE}" | sort -u
}
count_rows() { section_rows "$1" | grep -c '^|' || true; }

# Numbered or bulleted lines under every level-2+ heading matching the regex.
items_under() {
  awk -v re="$1" '
    BEGIN { IGNORECASE = 1; on = 0 }
    /^#+ / { on = ($0 ~ /^##+ / && $0 ~ re) ? 1 : 0; next }
    on && /^[[:space:]]*([0-9]+\.|[-*]) / { c++ }
    END { print c + 0 }
  ' "${INPUT_FILE}"
}

has() { grep -qiE -- "$1" "${INPUT_FILE}" && echo 1 || echo 0; }

# min(n/d, 1) with two decimals; 0 when d is 0.
capped() {
  local n=$1 d=$2
  if [[ ${d} -eq 0 ]]; then echo 0; return; fi
  echo "scale=2; if (${n} / ${d} > 1) 1 else ${n} / ${d}" | bc
}

# Share of the given regexes that appear at least once (one bounded vocabulary check).
family() {
  local hit=0 total=0 re
  for re in "$@"; do
    total=$((total + 1))
    grep -qiE -- "${re}" "${INPUT_FILE}" && hit=$((hit + 1))
  done
  capped "${hit}" "${total}"
}

# Claims table: | # | Claim | Source ref | UNCORROBORATED | Conflict |
CLAIMS_ROWS=$(section_rows 'claims')
CLAIMS_TOTAL=$(printf '%s\n' "${CLAIMS_ROWS}" | grep -c '^|' || true)
CLAIMS_SOURCED=$(printf '%s\n' "${CLAIMS_ROWS}" | awk -F'|' '$4 ~ /(S[0-9]|#[0-9]|[Ss]ource|https?:|:[0-9]+|[0-9])/ { c++ } END { print c + 0 }')
CLAIMS_UNCORROBORATED=$(printf '%s\n' "${CLAIMS_ROWS}" | awk -F'|' '$5 ~ /\[x\]/ { c++ } END { print c + 0 }')

URLS=$(grep -oiE 'https?://[^] )>|`"'"'"']+' "${INPUT_FILE}" | sort -u || true)
URL_COUNT=$(printf '%s\n' "${URLS}" | grep -c . || true)
DOMAIN_COUNT=$(printf '%s\n' "${URLS}" | sed -E 's#https?://([^/]+).*#\1#' | sort -u | grep -c . || true)
WORDS=$(wc -w < "${INPUT_FILE}")

CHECKS=()
check() { CHECKS+=("$1=$2"); echo "  ${1}=${2} ${3:-}" >&2; }

claim_source_ratio() {
  if [[ ${CLAIMS_TOTAL} -eq 0 ]]; then echo 0; else capped "${CLAIMS_SOURCED}" "${CLAIMS_TOTAL}"; fi
}

# ---- per-phase checks ----------------------------------------------------------------------

echo "research-score ${PHASE} (${SCORED}):" >&2
case "${PHASE}" in
  scope)
    Q=$(items_under 'question')
    check questions "$(capped "${Q}" 3)" "(${Q} research questions, 3 expected)"
    check boundary "$(has 'in scope|out of scope|scope boundar|boundar')" "(scope boundary stated)"
    check policy "$(has 'evidence policy|source (hierarchy|priority|reliab|order)|official.*>|academic.*>')" "(evidence policy stated)"
    if [[ $(has 'decision axes') == 1 ]] && grep -q 'CONFIRMED:' "${INPUT_FILE}" && ! grep -q 'CONFIRMED:.*<' "${INPUT_FILE}"; then
      check axes 1 "(Decision Axes with a filled CONFIRMED line)"
    else
      check axes 0 "(Decision Axes with a filled CONFIRMED line)"
    fi
    check vocabulary "$(family 'success criteria|acceptance' 'perspective' 'assumption' 'risk|constraint')" "(bounded word check)"
    ;;
  gather)
    SRC=$(count_rows 'sources')
    check sources "$(capped "${SRC}" 5)" "(${SRC} source rows, 5 expected)"
    check claims_sourced "$(claim_source_ratio)" "(${CLAIMS_SOURCED}/${CLAIMS_TOTAL} claim rows cite a source)"
    CONF=$(section_rows 'sources' | grep -ciE 'high|medium|low|verified|probable|official|academic' || true)
    check confidence "$(capped "${CONF}" "${SRC}")" "(${CONF}/${SRC} source rows carry a confidence or reliability label)"
    check preamble "$(has 'tooling preamble')" "(Tooling Preamble present)"
    if [[ ${URL_COUNT} -ge 2 ]]; then
      D=$(echo "scale=2; ${DOMAIN_COUNT} / ${URL_COUNT}" | bc)
      check diversity "$(echo "scale=2; if (${D} >= 0.3) 1 else ${D} / 0.3" | bc)" "(${DOMAIN_COUNT} domains over ${URL_COUNT} URLs)"
    fi
    ;;
  verify)
    check audit "$(family 'citation' 'uncorroborated' 'conflict' 'fresh|stale' 'reachab|exist|accessible|404|broken')" "(bounded word check)"
    if [[ ${CLAIMS_TOTAL} -eq 0 ]]; then
      check uncorroborated_rate 0 "(no claims table to audit)"
    else
      R=$(echo "scale=2; ${CLAIMS_UNCORROBORATED} / ${CLAIMS_TOTAL}" | bc)
      check uncorroborated_rate "$(echo "if (${R} < 0.2) 1 else if (${R} < 0.5) 0.5 else 0" | bc)" "(${CLAIMS_UNCORROBORATED}/${CLAIMS_TOTAL} claims uncorroborated, <0.2 expected)"
    fi
    check verdict "$(has 'verdict|PASS|WARN|FAIL')" "(audit verdict present)"
    check preamble "$(has 'tooling preamble')" "(Tooling Preamble present)"
    ;;
  filter)
    if [[ ${WORDS} -le 5000 ]]; then check budget 1 "(${WORDS} words, cap 5000)"; else check budget 0 "(${WORDS} words, cap 5000)"; fi
    check stats "$(has 'input claims|output claims|removed|dedup|merge|compression')" "(compression stats present)"
    SRC=$(count_rows 'sources')
    check sources "$(capped "${SRC}" 3)" "(${SRC} source rows kept)"
    check claims_sourced "$(claim_source_ratio)" "(${CLAIMS_SOURCED}/${CLAIMS_TOTAL} claim rows cite a source)"
    check conflicts "$(has 'conflict')" "(conflicts preserved or declared absent)"
    ;;
  synthesize)
    check citation_table "$(has 'citation table|## sources|references')" "(citation table present)"
    A=$(claim_source_ratio)
    check citation_accuracy "$(echo "scale=2; if (${A} >= 0.8) 1 else ${A}" | bc)" "(${CLAIMS_SOURCED}/${CLAIMS_TOTAL} claim rows cite a source, 0.8 expected)"
    SRC=$(count_rows 'sources|citation')
    check sources "$(capped "${SRC}" 3)" "(${SRC} source rows, 3 expected)"
    check structure "$(family 'executive summary|summary' 'finding' 'gap' 'recommend')" "(bounded word check)"
    ;;
  decide)
    check state "$(has 'ADOPT|DEFER|REJECT')" "(decision state present)"
    check reasoning "$(has 'reasoning|rationale|because')" "(reasoning documented)"
    EV=$(count_rows 'evidence')
    check evidence "$(capped "${EV}" 3)" "(${EV} evidence rows, 3 expected)"
    check target "$(has 'milestone|target|task|ADR|queue')" "(target milestone, task or ADR named)"
    ;;
  eval)
    KEYS=0
    for k in sources_consulted claims_made claims_with_source uncorroborated_rate conflicts_found stale_sources decision tokens_used "wall_clock(_s)?"; do
      grep -qiE "^[-* |]*${k}[[:space:]]*[:=|]" "${INPUT_FILE}" && KEYS=$((KEYS + 1))
    done
    check metrics "$(capped "${KEYS}" 9)" "(${KEYS}/9 metric keys from research:tdd recorded)"
    check traced "$(has 'claims_with_source|claims traced|trace')" "(claim-to-evidence trace recorded)"
    check scores "$(has 'score|metric')" "(phase scores recorded)"
    ;;
  *)
    echo "ERROR: unknown phase '${PHASE}'" >&2
    exit 2
    ;;
esac

SUM=0
for c in "${CHECKS[@]}"; do SUM=$(echo "scale=2; ${SUM} + ${c#*=}" | bc); done
SCORE=$(echo "scale=2; ${SUM} / ${#CHECKS[@]}" | bc)
case "${SCORE}" in .*) SCORE="0${SCORE}" ;; esac

echo "${SCORE}" > "${SCORE_FILE}"
echo "${SCORE}"
