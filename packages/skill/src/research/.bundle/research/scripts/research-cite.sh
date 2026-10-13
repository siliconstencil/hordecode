#!/usr/bin/env bash
# research-cite.sh -- citation audit for research evidence files
# Usage: ./research-cite.sh <run-id>
# Checks: source existence (URLs reachable), UNCORROBORATED flag count, conflict flag count
# Output: audit report to stdout, writes findings/<run-id>/cite-audit.md

set -euo pipefail

RUN_ID="${1:?Usage: research-cite.sh <run-id>}"
FINDINGS_DIR="findings/${RUN_ID}"
EVIDENCE_FILE="${FINDINGS_DIR}/gather.evidence"
AUDIT_FILE="${FINDINGS_DIR}/cite-audit.md"

if [[ ! -f "${EVIDENCE_FILE}" ]]; then
  echo "ERROR: gather evidence not found: ${EVIDENCE_FILE}" >&2
  exit 1
fi

# Extract URLs
URLS=$(grep -oP 'https?://[^\s\)\]\|]+' "${EVIDENCE_FILE}" | sort -u || true)
URL_COUNT=$(echo "${URLS}" | grep -c '^http' || true)

# Count UNCORROBORATED flags
UNCORROBORATED=$(grep -ci "uncorroborated\|unverified\|not.*confirm\|could.*not.*verify" "${EVIDENCE_FILE}" || true)

# Count conflict flags
CONFLICTS=$(grep -ci "conflict\|disagree\|contradict\|diverge\|inconsistent" "${EVIDENCE_FILE}" || true)

# Count unique sources (by domain)
DOMAINS=$(echo "${URLS}" | grep -oP '://[^/]+' | sort -u | wc -l || true)

# Check URL reachability (sample first 5, skip if no URLs)
REACHABLE=0
BROKEN=0
if [[ ${URL_COUNT} -gt 0 ]]; then
  SAMPLE=$(echo "${URLS}" | head -5)
  while IFS= read -r url; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}" 2>/dev/null || echo "000")
    if [[ "${HTTP_CODE}" =~ ^2 ]]; then
      REACHABLE=$((REACHABLE + 1))
    else
      BROKEN=$((BROKEN + 1))
    fi
  done <<< "${SAMPLE}"
fi

# Write audit report
cat > "${AUDIT_FILE}" << EOF
# Citation Audit -- Run ${RUN_ID}

> Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Summary
- Total URLs found: ${URL_COUNT}
- Unique domains: ${DOMAINS}
- URLs checked (sample): $((REACHABLE + BROKEN))
- Reachable: ${REACHABLE}
- Broken/unreachable: ${BROKEN}
- UNCORROBORATED flags: ${UNCORROBORATED}
- Conflict flags: ${CONFLICTS}

## Gate Assessment
EOF

# Gate logic
if [[ ${UNCORROBORATED} -gt 0 ]]; then
  echo "- **UNCORROBORATED**: ${UNCORROBORATED} claims flagged as unverified" >> "${AUDIT_FILE}"
fi
if [[ ${BROKEN} -gt 0 ]]; then
  echo "- **BROKEN URLS**: ${BROKEN} URLs unreachable (may need update or removal)" >> "${AUDIT_FILE}"
fi
if [[ ${CONFLICTS} -gt 0 ]]; then
  echo "- **CONFLICTS**: ${CONFLICTS} source disagreements detected" >> "${AUDIT_FILE}"
fi

# Exit code
if [[ ${UNCORROBORATED} -gt 3 ]] || [[ ${BROKEN} -gt 2 ]]; then
  echo "" >> "${AUDIT_FILE}"
  echo "**GATE: FAIL** -- too many uncorroborated/broken sources" >> "${AUDIT_FILE}"
  echo "Cite audit: FAIL (uncorroborated=${UNCORROBORATED}, broken=${BROKEN}, conflicts=${CONFLICTS})"
  exit 1
else
  echo "" >> "${AUDIT_FILE}"
  echo "**GATE: PASS**" >> "${AUDIT_FILE}"
  echo "Cite audit: PASS (uncorroborated=${UNCORROBORATED}, broken=${BROKEN}, conflicts=${CONFLICTS})"
  exit 0
fi
