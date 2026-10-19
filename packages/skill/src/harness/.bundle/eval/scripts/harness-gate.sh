#!/usr/bin/env bash
# harness-gate.sh -- per-phase evidence gate for harness pipeline runs
# Same mechanism as research-gate.sh, ported to the harness phases: a rule stated only in prose
# does not stop a skipped step; a nonzero exit code does.
#
# Usage: bash harness-gate.sh <run-id> <phase>
# Exit 0 = gate pass, exit 1 = gate fail
# Phases: brainstorm plan subagent verify review report eval merge
#
# Evidence file convention: .hordecode/harness/evidence/<run-id>/<phase>.evidence
# A phase's own skill must write this file BEFORE calling this gate.
# No file, empty file, or content missing the phase's required markers = FAIL.
# A FAIL must stop the pipeline -- "I did it anyway" is not an override.

set -euo pipefail

RUN_ID="${1:?Usage: harness-gate.sh <run-id> <phase>}"
PHASE="${2:?Usage: harness-gate.sh <run-id> <phase>}"
EVIDENCE_DIR=".hordecode/harness/evidence/${RUN_ID}"
EVIDENCE_FILE="${EVIDENCE_DIR}/${PHASE}.evidence"

case "${PHASE}" in
  brainstorm|ask|debug|plan|subagent|verify|review|report|eval|merge) ;;
  *) echo "ERROR: unknown phase '${PHASE}'. Valid: brainstorm ask debug plan subagent verify review report eval merge" >&2; exit 2 ;;
esac

if [[ ! -d "${EVIDENCE_DIR}" ]]; then
  echo "FAIL: evidence directory not found: ${EVIDENCE_DIR}" >&2
  echo "  Create it before starting phase '${PHASE}'." >&2
  exit 1
fi

if [[ ! -f "${EVIDENCE_FILE}" ]]; then
  echo "FAIL: evidence file not found: ${EVIDENCE_FILE}" >&2
  echo "  Phase '${PHASE}' must write ${EVIDENCE_FILE} before this gate can pass." >&2
  exit 1
fi

if [[ ! -s "${EVIDENCE_FILE}" ]]; then
  echo "FAIL: evidence file is empty: ${EVIDENCE_FILE}" >&2
  exit 1
fi

LINES=$(wc -l < "${EVIDENCE_FILE}")
WORDS=$(wc -w < "${EVIDENCE_FILE}")

case "${PHASE}" in
  brainstorm)
    if [[ ${LINES} -lt 3 ]]; then
      echo "FAIL: brainstorm evidence too short (${LINES} lines, minimum 3)" >&2
      exit 1
    fi
    # S1 mirror: when Decision Axes present, require CONFIRMED (grill-me)
    if grep -qi "decision axes" "${EVIDENCE_FILE}"; then
      if ! grep -q "CONFIRMED:" "${EVIDENCE_FILE}"; then
        echo "FAIL: brainstorm has Decision Axes but missing CONFIRMED: marker (S1)" >&2
        exit 1
      fi
      if grep -q "CONFIRMED:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: brainstorm CONFIRMED still placeholder (S1)" >&2
        exit 1
      fi
    fi
    ;;
  ask)
    if ! grep -qi "decision axes" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask evidence missing Decision Axes (S1)" >&2
      exit 1
    fi
    if ! grep -q "CONFIRMED:" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask evidence missing CONFIRMED: (S1)" >&2
      exit 1
    fi
    if grep -q "CONFIRMED:.*<.*>" "${EVIDENCE_FILE}"; then
      echo "FAIL: ask CONFIRMED still placeholder (S1)" >&2
      exit 1
    fi
    ;;
  debug)
    if ! grep -qi "repro script" "${EVIDENCE_FILE}"; then
      echo "FAIL: debug evidence missing Repro script (S1)" >&2
      exit 1
    fi
    if grep -q "Repro script.*<.*>" "${EVIDENCE_FILE}"; then
      echo "FAIL: debug Repro script still placeholder (S1)" >&2
      exit 1
    fi
    HYP_COUNT=$(grep -ci "If .* then" "${EVIDENCE_FILE}" || true)
    if [[ ${HYP_COUNT} -lt 2 ]]; then
      echo "FAIL: debug needs >=2 If X then Y (found ${HYP_COUNT}, S1)" >&2
      exit 1
    fi
    ;;
  plan)
    if ! grep -qi "task\|step\|file:" "${EVIDENCE_FILE}"; then
      echo "FAIL: plan evidence missing task/file breakdown" >&2
      exit 1
    fi
    ;;
  subagent)
    # Must reference at least one real file:line, not just prose
    if ! grep -qE '[A-Za-z0-9_./-]+\.(ts|tsx|py|sh|md):[0-9]+' "${EVIDENCE_FILE}"; then
      echo "FAIL: subagent evidence has no file:line citations" >&2
      exit 1
    fi
    ;;
  verify)
    # Must contain actual command output markers, not just claims
    if ! grep -qiE "\\\$ |exit code|PASS|FAIL|error|pass|fail" "${EVIDENCE_FILE}"; then
      echo "FAIL: verify evidence missing real command output (no \$/exit-code/PASS/FAIL markers)" >&2
      exit 1
    fi
    # S1: when Repro slot present, enforce non-placeholder + hypotheses
    if grep -qi "repro script" "${EVIDENCE_FILE}"; then
      if grep -q "Repro script.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: verify Repro script still placeholder (S1)" >&2
        exit 1
      fi
    fi
    if grep -qi "hypothes.*If .* then" "${EVIDENCE_FILE}"; then
      HYP2=$(grep -ci "If .* then" "${EVIDENCE_FILE}" || true)
      if [[ ${HYP2} -lt 2 ]]; then
        echo "FAIL: verify hypotheses need >=2 If X then Y (found ${HYP2}, S1)" >&2
        exit 1
      fi
    fi
    # S3 review conditional: when Standards vs Spec slots present, require both headings non-placeholder
    if grep -q "Standards vs Spec" "${EVIDENCE_FILE}"; then
      if ! grep -q "### Standards" "${EVIDENCE_FILE}" || ! grep -q "### Spec" "${EVIDENCE_FILE}"; then
        echo "FAIL: verify missing Standards and Spec headings (S3)" >&2
        exit 1
      fi
      if grep -q "<project norm\|<spec paragraph\|<file:line" "${EVIDENCE_FILE}"; then
        echo "FAIL: verify Standards/Spec slots still placeholder (S3)" >&2
        exit 1
      fi
    fi
    ;;
  review)
    if ! grep -qi "approved\|changes needed\|finding" "${EVIDENCE_FILE}"; then
      echo "FAIL: review evidence missing a verdict" >&2
      exit 1
    fi
    # S3 mirror for review: same Standards/Spec gate when slots present
    if grep -q "Standards vs Spec" "${EVIDENCE_FILE}"; then
      if ! grep -q "### Standards" "${EVIDENCE_FILE}" || ! grep -q "### Spec" "${EVIDENCE_FILE}"; then
        echo "FAIL: review missing Standards and Spec headings (S3)" >&2
        exit 1
      fi
      if grep -q "<project norm\|<spec paragraph\|<file:line" "${EVIDENCE_FILE}"; then
        echo "FAIL: review Standards/Spec slots still placeholder (S3)" >&2
        exit 1
      fi
    fi
    ;;
  report)
    if ! grep -qi "commit\|file:" "${EVIDENCE_FILE}"; then
      echo "FAIL: report evidence missing commit SHA or file:line diff" >&2
      exit 1
    fi
    # S2 deliberate mirror (research synthesize -> harness report)
    if grep -qi "deliberate trigger\|alternatives.*>=3\|confidence.*< *0\.9\|conflict.*> *0\.3" "${EVIDENCE_FILE}"; then
      DEL_FILE="${EVIDENCE_DIR}/seqthink-evidence.md"
      if [[ ! -s "${DEL_FILE}" ]]; then
        echo "FAIL: report deliberate trigger present but missing/empty ${DEL_FILE} (S2)" >&2
        exit 1
      fi
      if grep -qi "^SKIPPED:" "${DEL_FILE}"; then :; else
        if ! grep -q "Branch:\|Revision:" "${DEL_FILE}"; then
          echo "FAIL: report seqthink-evidence missing Branch: or Revision: (S2)" >&2
          exit 1
        fi
        HYP_D=$(grep -ci "hypothesis\|If .* then" "${DEL_FILE}" || true)
        if [[ ${HYP_D} -lt 2 ]]; then
          echo "FAIL: report seqthink-evidence needs >=2 hypotheses (found ${HYP_D}, S2)" >&2
          exit 1
        fi
        if ! grep -qi "reversal" "${DEL_FILE}"; then
          echo "FAIL: report seqthink-evidence missing reversal test (S2)" >&2
          exit 1
        fi
      fi
    fi
    # S3 report conditional: when Standards vs Spec present, require both headings non-placeholder
    if grep -q "Standards vs Spec" "${EVIDENCE_FILE}"; then
      if ! grep -q "### Standards" "${EVIDENCE_FILE}" || ! grep -q "### Spec" "${EVIDENCE_FILE}"; then
        echo "FAIL: report missing Standards and Spec headings (S3)" >&2
        exit 1
      fi
      if grep -q "<project norm\|<spec paragraph\|<file:line" "${EVIDENCE_FILE}"; then
        echo "FAIL: report Standards/Spec slots still placeholder (S3)" >&2
        exit 1
      fi
    fi
    ;;
  eval)
    if ! grep -qi "score\|metric\|pass\|fail" "${EVIDENCE_FILE}"; then
      echo "FAIL: eval evidence missing score/metrics" >&2
      exit 1
    fi
    # S4 conditional TDD mirror: same Seam/Slice/Stub when tdd/seam marker present
    # Trigger narrowed to slot markers only (Seam:/one-slice) -- bare "tdd" matches
    # stage names in eval JSON (e.g. "harness:tdd") and caused false FAILs.
    if grep -qi "Seam:\|one-slice" "${EVIDENCE_FILE}"; then
      if ! grep -q "Seam:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval TDD marker present but missing Seam: slot (S4)" >&2
        exit 1
      fi
      if grep -q "Seam:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Seam slot still placeholder (S4)" >&2
        exit 1
      fi
      if ! grep -q "Slice:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval missing Slice: slot (S4)" >&2
        exit 1
      fi
      if grep -q "Slice:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Slice slot still placeholder (S4)" >&2
        exit 1
      fi
      if ! grep -q "Stub check:" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval missing Stub check: slot (S4)" >&2
        exit 1
      fi
      if grep -q "Stub check:.*<.*>" "${EVIDENCE_FILE}"; then
        echo "FAIL: eval Stub check slot still placeholder (S4)" >&2
        exit 1
      fi
    fi
    ;;
  merge)
    if ! grep -qiE "[0-9a-f]{7,40}|fork/main|keep-as-is" "${EVIDENCE_FILE}"; then
      echo "FAIL: merge evidence missing a commit SHA or explicit merge decision" >&2
      exit 1
    fi
    # S2 deliberate mirror for merge (research decide -> harness merge)
    if grep -qi "deliberate trigger\|alternatives.*>=3\|confidence.*< *0\.9\|conflict.*> *0\.3" "${EVIDENCE_FILE}"; then
      DEL_FILE="${EVIDENCE_DIR}/seqthink-evidence.md"
      if [[ ! -s "${DEL_FILE}" ]]; then
        echo "FAIL: merge deliberate trigger present but missing/empty ${DEL_FILE} (S2)" >&2
        exit 1
      fi
      if grep -qi "^SKIPPED:" "${DEL_FILE}"; then :; else
        if ! grep -q "Branch:\|Revision:" "${DEL_FILE}"; then
          echo "FAIL: merge seqthink-evidence missing Branch: or Revision: (S2)" >&2
          exit 1
        fi
        HYP_D2=$(grep -ci "hypothesis\|If .* then" "${DEL_FILE}" || true)
        if [[ ${HYP_D2} -lt 2 ]]; then
          echo "FAIL: merge seqthink-evidence needs >=2 If X then Y (found ${HYP_D2}, S2)" >&2
          exit 1
        fi
        if ! grep -qi "reversal" "${DEL_FILE}"; then
          echo "FAIL: merge seqthink-evidence missing reversal test (S2)" >&2
          exit 1
        fi
      fi
    fi
    # S3 merge conditional: when Context Delta slots present, require non-placeholder
    if grep -q "Context Delta (S3" "${EVIDENCE_FILE}"; then
      if grep -q "<what changed" "${EVIDENCE_FILE}"; then
        echo "FAIL: merge Context Delta slot still placeholder (S3)" >&2
        exit 1
      fi
    fi
    if grep -q "ADR 3-Gate Checklist (S3" "${EVIDENCE_FILE}"; then
      if ! grep -q "Gate 1" "${EVIDENCE_FILE}" || ! grep -q "Gate 2" "${EVIDENCE_FILE}" || ! grep -q "Gate 3" "${EVIDENCE_FILE}"; then
        echo "FAIL: merge ADR 3-Gate checklist missing Gate 1/2/3 (S3)" >&2
        exit 1
      fi
    fi

    # Escalation gate: eval may record recurring
    # failures. harness:report step 9 requires STOP + user escalation before
    # merge when ANY recurring failure has occurrence_count >= 5 OR
    # consecutive=true. Prose said that; this script enforces it: if such a
    # failure exists and merge.evidence has no "ESCALATED:" line recording the
    # user decision, merge is blocked. The question "did the human see the eval
    # result before merge auto-proceeded" is now asked by the gate itself, not
    # left to the reporting agent's discretion.
    ESCALATION_REQUIRED=""
    EVAL_JSON=""
    if [[ -f "${EVIDENCE_DIR}/eval.evidence" ]]; then
      EVAL_JSON=$(grep -oE 'docs/harness/eval/[A-Za-z0-9._-]+\.json' "${EVIDENCE_DIR}/eval.evidence" | head -1)
    fi
    if [[ -z "${EVAL_JSON}" && -d "docs/harness/eval" ]] && command -v jq >/dev/null 2>&1; then
      EVAL_JSON=$(ls -t docs/harness/eval/*.json 2>/dev/null | head -1)
    fi
    if [[ -n "${EVAL_JSON}" && -f "${EVAL_JSON}" ]] && command -v jq >/dev/null 2>&1; then
      while IFS=$'\t' read -r FTYPE OCC CONS; do
        [[ -z "${FTYPE}" ]] && continue
        if [[ "${OCC}" -ge 5 ]] || [[ "${CONS}" == "true" ]]; then
          ESCALATION_REQUIRED="${ESCALATION_REQUIRED}${FTYPE} x${OCC} (consecutive=${CONS}); "
        fi
      done < <(jq -r '.recurring_failures[]?, .patterns_detected[]? | [.failure_type, (.occurrence_count // 0), (.consecutive // false)] | @tsv' "${EVAL_JSON}" 2>/dev/null)
    fi
    if [[ -n "${ESCALATION_REQUIRED}" ]]; then
      if ! grep -qiE '^ESCALATED:' "${EVIDENCE_FILE}"; then
        echo "FAIL: eval recorded recurring failure(s) at/above escalation threshold: ${ESCALATION_REQUIRED}" >&2
        echo "  harness:report step 9 requires STOP + user escalation before merge for any failure with" >&2
        echo "  occurrence_count >= 5 or consecutive=true. The eval result must have been seen and" >&2
        echo "  decided by the user before merge can proceed." >&2
        echo "  Add a line to ${EVIDENCE_FILE} recording the escalation and decision, e.g.:" >&2
        echo "    ESCALATED: <failure_type> x<N>, user decision: <decision>" >&2
        exit 1
      fi
    fi
    ;;
esac

echo "PASS: phase '${PHASE}' gate passed (${LINES} lines, ${WORDS} words)"
exit 0
