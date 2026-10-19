# Deep-Module Glossary Fragment -- referenced by research:plan + harness:plan

> Use this vocabulary when defining seams and modules. Copy the relevant rows into brief.md / plan.md, do not duplicate prose.

| Term | Definition | When to use | Anti-pattern |
|------|------------|-------------|--------------|
| Seam | Minimal interface between two modules that can be tested in isolation | Before any code -- define seam first (S4) | Starting from implementation file, no seam |
| Deep module | Hides complexity behind a narrow interface (many lines behind few methods) | When complexity >3 branches or >2 dependencies | Shallow wrapper with leaky abstraction |
| One-slice | Single seam + single behavior, shipped in one commit | Every TDD red-green-refactor cycle | Multi-seam batch, partial stubs |
| Stub gate | No TODO/stub passthrough remains in eval | Eval gate checks no placeholder seams | "TODO" left as passing eval |

Reference: MP codebase-design vocab (deferred skill, adopted as glossary fragment S4). Keep this file canonical; derived copies in harness plan templates reference this path.
