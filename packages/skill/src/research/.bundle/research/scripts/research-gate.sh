#!/usr/bin/env bash
# research-gate.sh -- per-phase evidence gate for research runs
# Usage: ./research-gate.sh <run-id> <phase>
# Exit 0 = gate pass, exit 1 = gate fail
# Phases: scope gather verify filter synthesize decide eval

set -euo pipefail

# METHODOLOGY phase detection (resilient):
# Phase 1 DETAILED-REPORT      -> basename contains DETAILED-REPORT
# Phase 2 INDUSTRY-EQUIVALENTS -> basename contains INDUSTRY-EQUIVALENTS or INDUSTRY (case-insensitive)
# Phase 3 DEEP-DIVE            -> basename contains DEEP-DIVE or JURY-MODEL or JURY or DEEPDIVE (covers MAX-MODE drift)
# Phase 4 CONCLUSION           -> basename contains CONCLUSION or REALITY-VS-DESIGN or COMPREHENSIVE-ANALYSIS (legacy)
# Phase 5 VALIDATION           -> basename contains VALIDATION
# Phase 6 COMPARISON           -> basename contains COMPARISON
# Notes: case-insensitive; count presence (1 file suffices); Phase 2 exempt flag --allow-missing-industry-equivalents;
#        Phase 4 dual match counts as present but emit WARN if >1 CONCLUSION candidate.

detect_phases() {
  local dir="$1" base
  local has1=0 has2=0 has3=0 has4=0 has5=0 has6=0
  shopt -s nullglob nocasematch
  for f in "$dir"/*.md; do
    base="$(basename "$f")"
    [[ "$base" == *"DETAILED-REPORT"* ]] && has1=1
    [[ "$base" == *"INDUSTRY-EQUIVALENTS"* || "$base" == *"INDUSTRY"* ]] && has2=1
    if [[ "$base" == *"DEEP-DIVE"* || "$base" == *"DEEPDIVE"* || "$base" == *"JURY-MODEL"* || "$base" == *"JURY"* ]]; then has3=1; fi
    if [[ "$base" == *"CONCLUSION"* || "$base" == *"REALITY-VS-DESIGN"* || "$base" == *"COMPREHENSIVE-ANALYSIS"* ]]; then has4=1; fi
    [[ "$base" == *"VALIDATION"* ]] && has5=1
    [[ "$base" == *"COMPARISON"* ]] && has6=1
  done
  shopt -u nocasematch
  echo "$has1 $has2 $has3 $has4 $has5 $has6"
}

check_methodology() {
  local dir="$1"; shift || true
  local force_final=0 allow_no_industry=0
  while [[ $# -gt 0 ]]; do case "$1" in
    --final) force_final=1; shift;;
    --allow-missing-industry-equivalents) allow_no_industry=1; shift;;
    *) shift;;
  esac; done

  if [[ ! -d "$dir" ]]; then
    echo "ERROR: research dir not found: $dir" >&2
    exit 2
  fi

  local is_final=$force_final
  local topic
  topic="$(basename "$dir")"
  if [[ $is_final -eq 0 && -f "research/INDEX.md" ]]; then
    if grep -qE "^\|[^|]*$topic[^|]*\|[^|]*\|[^|]*\|[^|]*FINAL" "research/INDEX.md"; then
      is_final=1
    fi
  fi
  if [[ $is_final -eq 0 && -f "INDEX.md" ]]; then
    if grep -qE "^\|[^|]*$topic[^|]*\|[^|]*\|[^|]*\|[^|]*FINAL" "INDEX.md"; then
      is_final=1
    fi
  fi

  local has1 has2 has3 has4 has5 has6
  read -r has1 has2 has3 has4 has5 has6 <<<"$(detect_phases "$dir")"
  local missing=()
  [[ $has1 -eq 0 ]] && missing+=("DETAILED-REPORT (Phase 1)")
  if [[ $has2 -eq 0 && $allow_no_industry -eq 0 ]]; then missing+=("INDUSTRY-EQUIVALENTS (Phase 2)"); fi
  [[ $has4 -eq 0 ]] && missing+=("CONCLUSION (Phase 4)")
  [[ $has5 -eq 0 ]] && missing+=("VALIDATION (Phase 5)")

  echo "Methodology check for $dir (topic: $topic, is_final=$is_final):"
  echo "  Phases present: 1:$has1 2:$has2 3:$has3 4:$has4 5:$has5 6:$has6"
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "MISSING: ${missing[*]}"
    local conclusion_count
    conclusion_count=$(ls -1 "$dir"/*.md 2>/dev/null | tr '[:lower:]' '[:upper:]' | grep -cE 'CONCLUSION|REALITY-VS-DESIGN|COMPREHENSIVE-ANALYSIS' || true)
    if [[ $conclusion_count -gt 1 ]]; then
      echo "WARN: multiple Phase-4 (CONCLUSION) candidates detected ($conclusion_count) — verify canonical naming"
    fi
    if [[ $is_final -eq 1 ]]; then
      echo "FAIL: mandatory phases missing for FINAL promotion"
      return 1
    else
      echo "WARN: mandatory phases missing but series is DRAFT — not blocking"
      return 0
    fi
  fi
  local conclusion_count2
  conclusion_count2=$(ls -1 "$dir"/*.md 2>/dev/null | tr '[:lower:]' '[:upper:]' | grep -cE 'CONCLUSION|REALITY-VS-DESIGN|COMPREHENSIVE-ANALYSIS' || true)
  if [[ $conclusion_count2 -gt 1 ]]; then
    echo "WARN: multiple Phase-4 (CONCLUSION) candidates detected ($conclusion_count2) — verify canonical naming"
  fi
  echo "PASS: all mandatory phases present"
  return 0
}

if [[ "${1:-}" == "--check-methodology" ]]; then
  dir="${2:-}"
  if [[ -z "$dir" ]]; then echo "Usage: $0 --check-methodology <research-dir> [--final] [--allow-missing-industry-equivalents]" >&2; exit 2; fi
  check_methodology "$dir" "${@:3}"
  exit $?
fi

RUN_ID="${1:?Usage: research-gate.sh <run-id> <phase>}"
PHASE="${2:?Usage: research-gate.sh <run-id> <phase>}"
FINDINGS_DIR="findings/${RUN_ID}"
EVIDENCE_FILE="${FINDINGS_DIR}/${PHASE}.evidence"

# Validate phase name (S1: ask/debug added as any-phase gates, Section 21)
case "${PHASE}" in
  scope|ask|debug|gather|verify|filter|synthesize|decide|eval) ;;
  *) echo "ERROR: unknown phase '${PHASE}'. Valid: scope ask debug gather verify filter synthesize decide eval" >&2; exit 2 ;;
esac

# Check findings dir exists
if [[ ! -d "${FINDINGS_DIR}" ]]; then
  echo "FAIL: findings directory not found: ${FINDINGS_DIR}" >&2
  echo "  Run research-worktree first to create the run workspace." >&2
  exit 1
fi

# Check evidence file exists
if [[ ! -f "${EVIDENCE_FILE}" ]]; then
  echo "FAIL: evidence file not found: ${EVIDENCE_FILE}" >&2
  echo "  Phase '${PHASE}' must write ${EVIDENCE_FILE} before gate check." >&2
  exit 1
fi

# Check evidence file is non-empty
if [[ ! -s "${EVIDENCE_FILE}" ]]; then
  echo "FAIL: evidence file is empty: ${EVIDENCE_FILE}" >&2
  exit 1
fi

# Phase-specific checks
LINES=$(wc -l < "${EVIDENCE_FILE}")
WORDS=$(wc -w < "${EVIDENCE_FILE}")

case "${PHASE}" in
  scope)
    # Brief must have at least 3 lines and mention research questions
    if [[ ${LINES} -lt 3 ]]; then
      echo "FAIL: scope evidence too short (${LINES} lines, minimum 3)" >&2
      exit 1
    fi
    if ! grep -qi "research question\|scope\|boundary\|evidence policy" "${EVIDENCE_FILE}"; then
      echo "FAIL: scope evidence missing required sections (research questions/scope/evidence policy)" >&2
      exit 1
    fi
    # S1: scope gate -- Decision Axes + CONFIRMED (grill-me). Advisory until S2 flag day if template not yet migrated: check only when axes marker present.
    if grep -qi "decision axes" "${EVIDENCE_FILE}"; then
      if ! grep -q "CONFIRMED:" "${EVIDENCE_FILE}"; then
        echo "FAIL: scope evidence has Decision Axes but missing CONFIRMED: marker (S1 grill-me gate)" >&2
        exit 1
      fi
      if grep -q "CONFIRMED:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: scope CONFIRMED marker still placeholder (fill with date, S1)" >&2
        exit 1
      fi
    fi
    ;;
  ask)
    # S1 any-phase gate: ask must have Decision Axes + CONFIRMED
    if ! grep -qi "decision axes" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask evidence missing Decision Axes section (S1 grill-me)" >&2
      exit 1
    fi
    if ! grep -q "CONFIRMED:" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask evidence missing CONFIRMED: marker (S1)" >&2
      exit 1
    fi
    if grep -q "CONFIRMED:.*<.*>" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask CONFIRMED still placeholder (S1)" >&2
      exit 1
    fi
    ;;
  debug)
    # S1 any-phase gate: repro script + >=2 If-X-then-Y hypotheses
    if ! grep -qi "repro script" "${EVIDENCE_FILE}"; then
      echo "FAIL: debug evidence missing Repro script slot (S1 diagnosing-bugs)" >&2
      exit 1
    fi
    if grep -q "Repro script.*<.*>" "${EVIDENCE_FILE}"; then
      echo "FAIL: debug Repro script still placeholder (S1)" >&2
      exit 1
    fi
    HYP_COUNT=$(grep -ci "If .* then" "${EVIDENCE_FILE}" || true)
    if [[ ${HYP_COUNT} -lt 2 ]]; then
      echo "FAIL: debug evidence needs >=2 If X then Y hypotheses (found ${HYP_COUNT}, S1)" >&2
      exit 1
    fi
    ;;
  gather)
    # Must have sources listed
    if ! grep -qi "source\|url\|arxiv\|doi\|http" "${EVIDENCE_FILE}"; then
      echo "FAIL: gather evidence has no sources listed" >&2
      exit 1
    fi
    # Must have at least 1 source per subtopic (rough check: 3+ lines with source indicators)
    SOURCE_COUNT=$(grep -ci "source\|url\|arxiv\|doi\|http" "${EVIDENCE_FILE}" || true)
    if [[ ${SOURCE_COUNT} -lt 1 ]]; then
      echo "FAIL: gather evidence needs at least 1 source (found ${SOURCE_COUNT})" >&2
      exit 1
    fi
    ;;
  verify)
    # Must mention citation check or UNCORROBORATED
    if ! grep -qi "citation\|uncorroborated\|source.*exist\|conflict" "${EVIDENCE_FILE}"; then
      echo "FAIL: verify evidence missing citation audit content" >&2
      exit 1
    fi
    # S3 review conditional: when Standards vs Spec slots present, require both headings non-placeholder
    if grep -q "Standards vs Spec" "${EVIDENCE_FILE}"; then
      if ! grep -q "### Standards" "${EVIDENCE_FILE}" || ! grep -q "### Spec" "${EVIDENCE_FILE}"; then
        echo "FAIL: verify missing Standards and Spec headings (S3 two-axis)" >&2
        exit 1
      fi
      if grep -q "<project norm\|<spec paragraph\|<file:line" "${EVIDENCE_FILE}"; then
        echo "FAIL: verify Standards/Spec slots still placeholder (fill or mark na, S3)" >&2
        exit 1
      fi
    fi
    ;;
  filter)
    # Token budget check (rough: file under 5K words)
    if [[ ${WORDS} -gt 5000 ]]; then
      echo "FAIL: filtered evidence exceeds 5K word budget (${WORDS} words)" >&2
      exit 1
    fi
    ;;
  synthesize)
    # Report must have citation table
    if ! grep -qi "citation\|source.*table\|references" "${EVIDENCE_FILE}"; then
      echo "FAIL: synthesize evidence missing citation table" >&2
      exit 1
    fi
    # S3 review conditional for report: when Standards vs Spec present, require both headings non-placeholder
    if grep -q "Standards vs Spec" "${EVIDENCE_FILE}"; then
      if ! grep -q "### Standards" "${EVIDENCE_FILE}" || ! grep -q "### Spec" "${EVIDENCE_FILE}"; then
        echo "FAIL: synthesize missing Standards and Spec headings (S3)" >&2
        exit 1
      fi
      if grep -q "<project norm\|<spec paragraph\|<file:line" "${EVIDENCE_FILE}"; then
        echo "FAIL: synthesize Standards/Spec slots still placeholder (S3)" >&2
        exit 1
      fi
    fi
    # S2 deliberate conditional gate: when trigger phrase present, require seqthink-evidence.md
    if grep -qi "deliberate trigger\|alternatives.*>=3\|confidence.*< *0\.9\|conflict.*> *0\.3" "${EVIDENCE_FILE}"; then
      DEL_FILE="${FINDINGS_DIR}/seqthink-evidence.md"
      if [[ ! -s "${DEL_FILE}" ]]; then
        echo "FAIL: synthesize deliberate trigger present but missing/empty ${DEL_FILE} (S2)" >&2
        exit 1
      fi
      if grep -qi "^SKIPPED:" "${DEL_FILE}"; then :; else
        if ! grep -q "Branch:\|Revision:" "${DEL_FILE}"; then
          echo "FAIL: seqthink-evidence missing Branch: or Revision: marker (S2)" >&2
          exit 1
        fi
        HYP_D=$(grep -ci "hypothesis\|If .* then" "${DEL_FILE}" || true)
        if [[ ${HYP_D} -lt 2 ]]; then
          echo "FAIL: seqthink-evidence needs >=2 hypotheses (found ${HYP_D}, S2)" >&2
          exit 1
        fi
        if ! grep -qi "reversal" "${DEL_FILE}"; then
          echo "FAIL: seqthink-evidence missing reversal test (S2)" >&2
          exit 1
        fi
      fi
    fi
    ;;
  decide)
    # Must have ADOPT/DEFER/REJECT
    if ! grep -qi "ADOPT\|DEFER\|REJECT" "${EVIDENCE_FILE}"; then
      echo "FAIL: decide evidence missing decision state (ADOPT/DEFER/REJECT)" >&2
      exit 1
    fi
    # S2 deliberate mirror for decide
    if grep -qi "deliberate trigger\|alternatives.*>=3\|confidence.*< *0\.9\|conflict.*> *0\.3" "${EVIDENCE_FILE}"; then
      DEL_FILE="${FINDINGS_DIR}/seqthink-evidence.md"
      if [[ ! -s "${DEL_FILE}" ]]; then
        echo "FAIL: decide deliberate trigger present but missing/empty ${DEL_FILE} (S2)" >&2
        exit 1
      fi
      if grep -qi "^SKIPPED:" "${DEL_FILE}"; then :; else
        if ! grep -q "Branch:\|Revision:" "${DEL_FILE}"; then
          echo "FAIL: decide seqthink-evidence missing Branch: or Revision: (S2)" >&2
          exit 1
        fi
        HYP_D2=$(grep -ci "hypothesis\|If .* then" "${DEL_FILE}" || true)
        if [[ ${HYP_D2} -lt 2 ]]; then
          echo "FAIL: decide seqthink-evidence needs >=2 hypotheses (found ${HYP_D2}, S2)" >&2
          exit 1
        fi
        if ! grep -qi "reversal" "${DEL_FILE}"; then
          echo "FAIL: decide seqthink-evidence missing reversal test (S2)" >&2
          exit 1
        fi
      fi
    fi
    # S3 merge conditional: when Context Delta slots present, require non-placeholder
    if grep -q "Context Delta (S3" "${EVIDENCE_FILE}"; then
      if grep -q "<what changed" "${EVIDENCE_FILE}"; then
        echo "FAIL: decide Context Delta slot still placeholder (fill or mark na, S3)" >&2
        exit 1
      fi
    fi
    if grep -q "ADR 3-Gate Checklist (S3" "${EVIDENCE_FILE}"; then
      if ! grep -q "Gate 1" "${EVIDENCE_FILE}" || ! grep -q "Gate 2" "${EVIDENCE_FILE}" || ! grep -q "Gate 3" "${EVIDENCE_FILE}"; then
        echo "FAIL: decide ADR 3-Gate checklist missing Gate 1/2/3 (S3)" >&2
        exit 1
      fi
    fi
    ;;
  eval)
    # Must have metrics
    if ! grep -qi "metric\|score\|source.*count\|claim\|token" "${EVIDENCE_FILE}"; then
      echo "FAIL: eval evidence missing metrics" >&2
      exit 1
    fi
    # S4 conditional TDD gates: only when tdd/seam/one-slice marker present (code runs only)
    if grep -qi "tdd\|seam\|one-slice" "${EVIDENCE_FILE}"; then
      if ! grep -q "Seam:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval TDD marker present but missing Seam: slot (S4 seam-first)" >&2
        exit 1
      fi
      if grep -q "Seam:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Seam slot still placeholder (S4)" >&2
        exit 1
      fi
      if ! grep -q "Slice:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval missing Slice: slot (S4 one-slice)" >&2
        exit 1
      fi
      if grep -q "Slice:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Slice slot still placeholder (S4)" >&2
        exit 1
      fi
      if ! grep -q "Stub check:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval missing Stub check: slot (S4 stub gate)" >&2
        exit 1
      fi
      if grep -q "Stub check:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Stub check slot still placeholder (S4)" >&2
        exit 1
      fi
    fi
    ;;
esac

# Tooling Preamble enforcement for bash-heavy phases (P2, F9)
if [[ "${PHASE}" == "gather" || "${PHASE}" == "verify" ]]; then
  if ! grep -qi "tooling preamble" "${EVIDENCE_FILE}"; then
    echo "FAIL: ${PHASE} evidence missing Tooling Preamble section (required per P2/F9 -- declare bash preamble, trajectory hits, read-only assertion)" >&2
    exit 1
  fi
  # S1: when Repro slot present (debug runs), enforce non-placeholder + hypotheses
  if grep -qi "repro script" "${EVIDENCE_FILE}"; then
    if grep -q "Repro script.*<.*>" "${EVIDENCE_FILE}"; then
      echo "FAIL: ${PHASE} Repro script slot still placeholder (fill or remove slot, S1)" >&2
      exit 1
    fi
  fi
  if grep -qi "hypothes.*If .* then" "${EVIDENCE_FILE}"; then
    HYP2=$(grep -ci "If .* then" "${EVIDENCE_FILE}" || true)
    if [[ ${HYP2} -lt 2 ]]; then
      echo "FAIL: ${PHASE} hypotheses need >=2 If X then Y (found ${HYP2}, S1)" >&2
      exit 1
    fi
  fi
fi

echo "PASS: phase '${PHASE}' gate passed (${LINES} lines, ${WORDS} words)"
exit 0
