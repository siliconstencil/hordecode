#!/usr/bin/env bash
# research-index.sh -- INDEX.md maintenance helper for research pipeline
# Usage: ./research-index.sh <file> <date> <status> <tags>
# Appends one File | Topic | Phase | Status row to ## Topic Reports.
# HC-22: one Topic Reports table; an unknown topic directory never maps to ## Architecture.
# Example: ./research-index.sh "architecture/NEW-DOC.md" "Jul 31" "DRAFT" "topic description"

set -euo pipefail

FILE="${1:?Usage: research-index.sh <file> <date> <status> <tags>}"
DATE="${2:?Usage: research-index.sh <file> <date> <status> <tags>}"
STATUS="${3:?Usage: research-index.sh <file> <date> <status> <tags>}"
TAGS="${4:?Usage: research-index.sh <file> <date> <status> <tags>}"

INDEX="INDEX.md"

if [[ ! -f "${INDEX}" ]]; then
  echo "ERROR: ${INDEX} not found. Run from research/ directory." >&2
  exit 1
fi

# HC-22: one Topic Reports table. An unknown topic directory never maps to ## Architecture.
SECTION_HEADER="## Topic Reports"
if ! grep -qF "${SECTION_HEADER}" "${INDEX}"; then
  echo "ERROR: ${SECTION_HEADER} table not found in ${INDEX}" >&2
  exit 1
fi

TOPIC="${FILE%%/*}"
[[ "${TOPIC}" == "${FILE}" ]] && TOPIC="root"

_up="$(echo "${FILE}" | tr '[:lower:]' '[:upper:]')"
PHASE="-"
case "${_up}" in
  *DETAILED-REPORT*) PHASE="DETAILED-REPORT" ;;
  *INDUSTRY-EQUIVALENTS*) PHASE="INDUSTRY-EQUIVALENTS" ;;
  *DEEP-DIVE*|*DEEPDIVE*) PHASE="DEEP-DIVE" ;;
  *CONCLUSION*) PHASE="CONCLUSION" ;;
  *VALIDATION*) PHASE="VALIDATION" ;;
  *COMPARISON*) PHASE="COMPARISON" ;;
  *COMPREHENSIVE-ANALYSIS*) PHASE="COMPREHENSIVE-ANALYSIS" ;;
esac

# Methodology gate: block FINAL promotion if mandatory phases are missing.
# HC-22: the gate accepts only <topic>/INDUSTRY-WAIVER.md for Phase 2; no flag is passed.
if [[ "${STATUS}" == "FINAL" ]]; then
  if [[ "${_up}" == *"DETAILED-REPORT"* || "${_up}" == *"INDUSTRY"* || "${_up}" == *"DEEP-DIVE"* || "${_up}" == *"JURY"* || "${_up}" == *"CONCLUSION"* || "${_up}" == *"VALIDATION"* || "${_up}" == *"COMPARISON"* || "${_up}" == *"COMPREHENSIVE"* ]]; then
    _topic_dir="$(dirname "$FILE")"
    _first_seg="${FILE%%/*}"
    _gate_dir=""
    for _c in "$_topic_dir" "research/$_topic_dir" "$_first_seg" "research/$_first_seg"; do
      if [[ -n "$_c" && "$_c" != "." && -d "$_c" ]]; then _gate_dir="$_c"; break; fi
    done
    if [[ -n "$_gate_dir" && -d "$_gate_dir" ]]; then
      if ! bash "$(dirname "$0")/research-gate.sh" --check-methodology "$_gate_dir" --final; then
        echo "research-index: FINAL promotion blocked by methodology gate (see MISSING above)" >&2
        exit 1
      fi
    fi
  fi
fi

# Check the current catalog only. The historical block keeps retired paths and must not
# make a new promotion look like a duplicate.
CURRENT="$(awk '/^## Historical catalog \(pre-2026-11-20\)/{exit} {print}' "${INDEX}")"
if printf '%s\n' "${CURRENT}" | grep -qF "\`${FILE}\`"; then
  echo "SKIP: ${FILE} already in INDEX" >&2
  exit 0
fi

ROW="| \`${FILE}\` | ${TOPIC} | ${PHASE} | ${STATUS} |"

# HC-22: insert after the last table row of Topic Reports, before trailing blanks or the next header.
awk -v header="${SECTION_HEADER}" -v row="${ROW}" '
  $0 == header { found = 1; in_section = 1; print; next }
  in_section && /^## / {
    if (!printed) { print row; printed = 1 }
    for (i = 1; i <= n; i++) print buf[i]
    n = 0; in_section = 0; print; next
  }
  in_section && /^\|/ {
    for (i = 1; i <= n; i++) print buf[i]
    n = 0; print; last = 1; next
  }
  in_section && last && !printed && /^[[:space:]]*$/ { buf[++n] = $0; next }
  in_section {
    for (i = 1; i <= n; i++) print buf[i]
    n = 0; print; next
  }
  { print }
  END {
    if (!found) exit 3
    if (in_section && !printed) {
      print row
      for (i = 1; i <= n; i++) print buf[i]
    }
  }
' "${INDEX}" > "${INDEX}.tmp" && mv "${INDEX}.tmp" "${INDEX}"

echo "Added: ${FILE} to ${SECTION_HEADER#\#\# } (${PHASE}) in ${INDEX}"
