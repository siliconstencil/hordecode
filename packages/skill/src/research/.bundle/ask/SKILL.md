---
name: research:ask
description: Ask the user to settle what a research run should cover (audience, time frame, region, decision at stake) through the question tool, at most once per run. Use from the research skill when the request is ambiguous.
---

# Ask before scoping

Use the `question` tool, never a question in prose: a prose question ends the turn and stops the
run.

- Ask one round with at most 3 questions, each with 2-4 concrete options and your recommended
  option first.
- Ask only what changes the research: audience, time frame, region, depth, or the decision the
  answer feeds.
- Put the user's answers, and the assumptions you made instead of asking, into `brief.md`.
- If the `question` tool is denied or no user answers, choose the recommended options, write them
  into `brief.md` as assumptions, and continue.
