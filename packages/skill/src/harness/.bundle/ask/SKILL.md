---
name: harness:ask
description: "Use whenever you need a decision, clarification, or approval from the user - covers how to ask with the question tool, and how to resolve the decision yourself when no user is available (question tool absent, or a [Never-Ask] response)"
---

# Asking the User

## The Rule

Every time you need the user to decide, clarify, or approve something, call the `question` tool. **Never** stop the loop with a natural-language question ("Does this look right?", "Should I proceed?"). A prose question ends your turn without finishing the task; a `question` call does not. The loop ends only when the task is complete.

Do not ask for facts the repository or environment already answers, and do not ask for permission to continue when no decision remains.

## How to Ask

- **Structured options:** when the decision has known choices, list them as `options`, each with a short `label` and a `description` of the consequence. Put your recommendation first and end its label with `(Recommended)`.
- **Open-ended:** when choices cannot be enumerated, pass `options: []`; the user types a free-text answer.
- **One decision per question:** a single decision may bundle dependent fields; unrelated decisions are separate questions.
- **Don't repeat the question in prose:** the tool renders it.

```
question({
  questions: [{
    question: "Which auth strategy should I use?",
    header: "Auth",
    options: [
      { label: "Session cookies (Recommended)", description: "Server-side sessions, simplest" },
      { label: "JWT", description: "Stateless, good for multiple services" },
    ],
  }],
})
```

## When No User Is Available

Two situations give no human answer; the decision behavior is the same in both:

1. **Question tool absent** (for example in an unattended run): decide and proceed directly.
2. **`[Never-Ask]` response:** you called `question`, and it returned a directive instead of an answer.

In both cases resolve **this one decision** yourself, state the option you chose and why in your response, and continue.

### How to decide autonomously

The best option for a present user is often not the best for unattended execution:

1. Choose the `(Recommended)` option when repository evidence still supports it and it can run unattended.
2. Otherwise choose the closest **minimal-scope** option the evidence supports; prefer **text-only** and **non-interactive** paths (no browser companion, no GUI).
3. When approval is the only thing requested for ordinary work (a design, a plan, a spec), treat it as granted and continue.
4. **Never auto-approve finishing or destructive actions:** merging into the base branch, pulling, pushing, opening a pull request, committing the repository's `.gitignore`, deleting branches, commits, worktrees or data, force-pushing. Choose the non-destructive path that preserves progress (keep things as they are), report the suggested action, and continue with the rest of the task.

### Only this turn

Autonomous resolution applies only to the current question. At the next decision point, call `question` again; the user may have returned.

## Why this skill exists

This is the single source of truth for asking and for the autonomous fallback. Other harness skills point here at their decision points instead of repeating the rules.
