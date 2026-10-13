---
name: learn-everything
description: Turn an uploaded document, paper, chapter, URL, or topic into a structured interactive learning course with exercises, quizzes, hints, and spaced review. Use when the user wants to study, master, or practice a subject.
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Learn Everything

Convert source material (PDF, paper, book chapter, URL, or a user-stated
topic) into a chapter-by-chapter learning course. The learner drives the pace;
the course adapts.

## Course construction

1. Extract the material's structure: chapters, sections, or logical units.
   Keep page/section references for documents so the learner can return to
   the source.
2. Build one module per unit with three parts:
   - **Teach**: the concept explained at the learner's stated level.
   - **Practice**: exercises with hints, graded by you.
   - **Assess**: a short quiz per module, plus a final assessment at the end.
3. Sequence modules so each builds on the previous. Do not dump all content
   at once — present incrementally, one module at a time.

## Teaching discipline

- Adapt explanations to the learner's level (beginner / intermediate /
   advanced). Ask when unsure.
- Reference the source material with section or page numbers instead of
   paraphrasing away its structure.
- When the learner returns to a previous course, resume from where they
   stopped — keep a course-state record (saved file or state block).

## Review loop

- Grade each answer; on error, give a targeted hint pointing at the relevant
   module section, then let the learner retry.
- Schedule spaced review: re-ask previously missed items at growing
   intervals before advancing.
- The course ends with a final assessment that samples every module.

## Anti-patterns

- Dumping the whole source as one wall of content.
- Skipping the learner-level question and teaching at the wrong depth.
- Losing course state between sessions.
