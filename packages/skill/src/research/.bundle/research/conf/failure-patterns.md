# Research Pipeline -- Known Failure Patterns

> Maintained by research:debug skill. Updated after each failed run.
> Analog to harness's eval/failure-patterns.md.

---

## F1: Scope Drift

**Symptom:** Brief expands mid-research; subtopics multiply; GATHER exceeds budget.
**Root cause:** Unclear intent; user question ambiguous; STORM decomposition too aggressive.
**Fix:** research:ask MUST clarify intent before research:scope; max 5 subtopics per brief.
**Detection:** GATHER phase score < 0.3 OR token budget exceeded.
**First seen:** ---

## F2: Source Hallucination

**Symptom:** Evidence lists URLs that return 404; citations to non-existent papers.
**Root cause:** Model generates plausible but fake URLs; no verification step.
**Fix:** research-cite.sh checks URL reachability; VERIFY phase MUST flag unverifiable sources.
**Detection:** research-cite.sh exit 1 (broken URLs > 2).
**First seen:** ---

## F3: UNCORROBORATED Inflation

**Symptom:** >20% of claims marked UNCORROBORATED; report lacks authoritative grounding.
**Root cause:** GATHER phase uses low-reliability sources (blogs, forums); no source hierarchy enforcement.
**Fix:** research-review checks source reliability hierarchy (academic/official > industry-primary > blog); reject blogs as primary source.
**Detection:** research-cite.sh uncorroborated_count > 3.
**First seen:** ---

## F4: Disjoint Report (Cognition Anti-Pattern)

**Symptom:** Report sections read like independent documents; no narrative thread.
**Root cause:** Multi-agent writing (parallel section authorship).
**Fix:** research-report SKILL explicitly states ONE-SHOT synthesis; never parallel sections.
**Detection:** research:tdd claim-to-evidence traceability fails across sections.
**First seen:** ---

## F5: Gate Theater

**Symptom:** Gates pass but output is low quality; scripts become ceremony.
**Root cause:** Gate criteria too loose; keyword scoring gamed.
**Fix:** research:tdd checklist is the real quality gate; keyword scoring is advisory, not authoritative.
**Detection:** Low eval score despite gate PASS; user feedback flags quality issues.
**First seen:** ---

## F6: Token Bloat

**Symptom:** GATHER phase consumes >40K tokens; run exceeds time budget.
**Root cause:** Too many sub-agents; sub-agents return un-compressed results.
**Fix:** Max 5 concurrent sub-agents; sub-agents MUST compress before returning (evidence template, not raw text).
**Detection:** GATHER phase time > 15min OR token count > 40K.
**First seen:** ---

## F7: Stale DRAFT Accumulation

**Symptom:** DRAFT docs pile up; no FINAL promotions; distillation deferred.
**Root cause:** No TTL enforcement; distillation step skipped.
**Fix:** research-distill.sh monthly scan; >30d DRAFT auto-flagged; triage required.
**Detection:** research-distill.sh stale_count > 5.
**First seen:** ---

## F8: Decision Bypass

**Symptom:** Research runs end with a report but no ADOPT/DEFER/REJECT decision; findings don't reach QUEUE/ADR.
**Root cause:** research:merge skill skipped; user accepts report without formal decision.
**Fix:** research:gate enforces DECIDE phase completion; report cannot be FINAL without decision state.
**Detection:** Report marked FINAL but no matching QUEUE/ADR entry.
**First seen:** ---

## F9: Doc-to-Command Disconnect (distill, 2026-08-08)

**Symptom:** A workflow is documented procedurally in a research doc (e.g. sqlite3 -readonly preamble, git log + diff + show verification flow) but NOT packaged as a command/skill. Agents hand-assemble bash sequences on every run instead of invoking a named primitive.
**Root cause:** research-pipeline gate scripts check evidence-file existence and keyword presence, but do NOT verify that the documented bash preamble (or `-readonly` flag) was actually invoked; no trajectory-frequency feedback loop exists to surface repeated manual patterns.
**Fix:** research-distill.sh now queries hordecode.db trajectory frequency per pattern; research-gate.sh enforces `## Tooling Preamble` field in evidence.md for bash-heavy phases; missing commands auto-flagged when trajectory hits >1000 and doc exists without `.mimocode/command/` entry.
**Detection:** research-distill.sh trajectory query shows >1000 hits for a pattern whose doc procedure has no corresponding `.hordecode/command/` or `~/.local/bin/` entry.
**First seen:** 2026-08-08 distill pass (distill-report.md §7-9: 55K+ git-verify, 1.3K sqlite3, 7.7K grep-error-TS)
