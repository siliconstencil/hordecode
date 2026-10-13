---
name: data-analytics
description: Quantitative product or business analysis — data quality checks, metric diagnostics, KPI design and reporting, dashboards, analytical reports, charts, notebooks, market sizing, semantic layers, and evidence-backed recommendations. Use whenever Data Analytics is explicitly invoked or the task is analytic.
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Data Analytics

Every analysis follows: understand the question, audit the data, compute with reproducible steps, state effect sizes and caveats, then recommend.

## Data quality first

- Inspect the actual data before computing: schema, null rates, duplicates, date ranges, units.
- State any data limitation that changes what can be concluded.

## Metric design

- A KPI must have a definition, a source, a computation, and an owner. If any is missing, name it.
- Prefer ratios and per-unit metrics over raw counts when comparing across segments or time.

## Analysis discipline

- Form a hypothesis before computing; do not fish for correlations and report the survivor.
- Report effect sizes and confidence, not just "significant".
- Keep the analysis reproducible: show the steps, not just the answer.

## Reporting

- Charts must have labeled axes, units, and a caption stating the takeaway.
- Separate measured numbers from estimates; mark estimates with their assumptions.
