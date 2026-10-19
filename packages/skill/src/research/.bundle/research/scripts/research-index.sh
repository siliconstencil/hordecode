#!/usr/bin/env bash
# research-index.sh -- INDEX.md maintenance helper for research pipeline
# Usage: ./research-index.sh <file> <date> <status> <tags>
# Appends a row to the correct section of INDEX.md based on file path prefix
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

# Determine section from file path prefix
SECTION=$(echo "${FILE}" | cut -d'/' -f1)
case "${SECTION}" in
  architecture) SECTION_HEADER="## Architecture" ;;
  harness) SECTION_HEADER="## Harness" ;;
  memory) SECTION_HEADER="## Memory" ;;
  tui-web) SECTION_HEADER="## TUI" ;;
  surveys) SECTION_HEADER="## Surveys" ;;
  upgrade) SECTION_HEADER="## Upgrade" ;;
  fork) SECTION_HEADER="## Fork" ;;
  archive) SECTION_HEADER="## Archive" ;;
  *) echo "WARN: unknown section '${SECTION}', appending to Architecture" >&2; SECTION_HEADER="## Architecture" ;;
esac

# Methodology gate: block FINAL promotion if mandatory phases missing (P2 research-gate methodology flag)
if [[ "${STATUS}" == "FINAL" ]]; then
  _gate_file_upper="$(echo "$FILE" | tr '[:lower:]' '[:upper:]')"
  if [[ "$_gate_file_upper" == *"DETAILED-REPORT"* || "$_gate_file_upper" == *"INDUSTRY"* || "$_gate_file_upper" == *"DEEP-DIVE"* || "$_gate_file_upper" == *"JURY"* || "$_gate_file_upper" == *"CONCLUSION"* || "$_gate_file_upper" == *"VALIDATION"* || "$_gate_file_upper" == *"COMPARISON"* || "$_gate_file_upper" == *"COMPREHENSIVE"* ]]; then
    _topic_dir="$(dirname "$FILE")"
    _first_seg="$(echo "$FILE" | cut -d'/' -f1)"
    _gate_dir=""
    for _c in "$_topic_dir" "research/$_topic_dir" "$_first_seg" "research/$_first_seg"; do
      if [[ -n "$_c" && -d "$_c" ]]; then _gate_dir="$_c"; break; fi
    done
    if [[ -n "$_gate_dir" && -d "$_gate_dir" ]]; then
      _allow_flag=""
      if ! bash "$(dirname "$0")/research-gate.sh" --check-methodology "$_gate_dir" --final $_allow_flag; then
        echo "research-index: FINAL promotion blocked by methodology gate (see MISSING above)" >&2
        exit 1
      fi
    fi
  fi
fi

# Check if file already exists in INDEX
if grep -qF "${FILE}" "${INDEX}"; then
  echo "SKIP: ${FILE} already in INDEX" >&2
  exit 0
fi

# Find the section and append after its last row
# Strategy: find the section header, then find the next section header or ---, insert before it
ROW="| \`${FILE}\` | ${DATE} | ${STATUS} | ${TAGS} |"

# Use awk to insert the row at the end of the target section
awk -v section="${SECTION_HEADER}" -v row="${ROW}" '
  /^## / { in_section = 0 }
  $0 == section { in_section = 1; found_section = 1 }
  in_section && /^$/ && !printed { print row; printed = 1 }
  { print }
  END { if (!printed && found_section) print row }
' "${INDEX}" > "${INDEX}.tmp" && mv "${INDEX}.tmp" "${INDEX}"

echo "Added: ${FILE} to ${SECTION} section of ${INDEX}"
