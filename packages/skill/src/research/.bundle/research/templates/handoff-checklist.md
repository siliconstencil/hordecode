# Handoff Redaction Checklist -- MP handoff (reference, S4)

> Apply before checkpoint writer / MEMORY.md append. MP handoff's redaction rules as checklist, not a new phase.

- [ ] No secrets in handoff (tokens, service suffixes, personal names beyond role)
- [ ] No system prompt leakage
- [ ] No raw tool output with credentials
- [ ] Decision vs fact separated (facts remain, tentative decisions marked)
- [ ] Source lines kept or explicitly marked UNCORROBORATED
- [ ] Token budget noted (handoff <= 3K)

Derived from MP handoff redaction pattern (S4, reference only). Gate: manual review, not mechanical exit-code.
