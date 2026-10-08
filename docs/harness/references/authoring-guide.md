# Authoring guide

How to turn a process into a Visage workflow that agents run reliably.

## 1. Find the steps

- Give each step one responsibility that an agent can finish in one go: *write the plan*, *implement*, *review*, *fix*. Split a step when its instructions describe two unrelated jobs; merge steps that always run together and never decide anything.
- Put a decision wherever the path can change: a review, a test, a triage. That step gets an evaluation; the others just produce files.
- Name the end states after their outcome (`published`, `rejected`, `needs-human`), with a `description` the agent can report to the user.
- Ask the user about loops: how many review rounds are acceptable, and what happens when the work never passes.

## 2. Choose the evaluation

| The step answers... | Use | Arcs |
| --- | --- | --- |
| a yes/no question | `predicate` | yes → continue, no → fix or stop |
| which of a few known outcomes applies | `choice` | one arc per option |
| how good or how likely something is | `score` | thresholds, best first, then otherwise |

Write the `question` as the exact question the step must answer, with the criterion: *"Does the game load and can a level be completed, with evidence from a test run?"* is better than *"Is it good?"*.

Prefer `predicate` or `choice` when the outcomes are discrete; a `score` invites arbitrary numbers. Use `score` for gradual judgements (completeness, confidence, quality) and keep thresholds few, for example `>= 0.8` publish, `>= 0.5` revise, otherwise rewrite.

## 3. Write each step's Skill

The exported runner gives the agent, for every step: the step's Skill (`step_file`), the run `input`, the outputs of earlier steps (`previous_outputs.<step>`), the step's reference files (`resources_dir`) and a folder for files it produces (`artifact_dir`). Write the Skill as instructions for an agent that sees nothing else:

```markdown
# Review the draft

Read the draft file named in `previous_outputs.draft.draft_file` and the brief in `input.topic`.
Check it against `checklist.md` in this step's folder: accuracy, structure, tone, length (800-1200 words).

- If every item passes, the result is `approved`.
- If fixable problems remain, the result is `changes`; list each one in `issues` so the draft step can fix it.
- If the draft does not answer the brief at all, the result is `rejected`.

Write the review to `review.md` in the artifact folder.
Finish with one JSON object: {"result": "approved" | "changes" | "rejected", "reason": "...", "issues": ["..."], "review_file": "review.md"}
```

Guidelines:

- **Inputs**: name the exact keys to read (`input.topic`, `previous_outputs.review.issues`). Keys of earlier outputs are whatever those steps returned, so keep them consistent across Skills.
- **Decision**: for evaluated steps, describe when each result applies, using the same words as the `question` and the `options`.
- **Output**: end with the JSON the step returns. Evaluated steps must include `result` and should include a short `reason`; add the keys later steps need (`issues`, file names). Steps without evaluation can return any object, such as `{"plan_file": "PLAN.md"}`.
- **Files**: say where files go. Reference files the step needs (guidelines, templates, examples) go next to its `SKILL.md` with `write_file`, and the Skill names them.
- **Self-contained**: do not mention Visage, the runner or other steps' instructions; the orchestrator Skill handles the protocol.

## 4. Handle failure and loops

- `max_attempts: 2` or `3` on evaluated steps absorbs an occasional malformed answer (it counts tries in total, so `2` means one retry); the retry includes the validation error.
- `on_fail` sends a step that keeps answering badly (an invalid result, not a negative one) somewhere useful: a fix step, or a `needs-human` end state. Without it the run fails.
- Loops (review → fix → review) are normal. Give them an explicit exit: an arc such as `when: state.attempts.fix >= 3` → `needs-human`, placed before the arc back into the loop. `max_steps` is only a safety net: reaching it fails the run.
- Every result of every evaluated step needs an arc. `validate_project` warns about the missing ones.

## 5. Patterns

**Pipeline**: steps that each build on the previous one, no decisions.
```
plan → implement → done
```

**Review loop**: work, check, fix until it passes.
```
implement → verify (predicate) ─ yes → done
                               └ no  → fix → verify
```
Add `state.attempts.fix >= 3 → needs-human` to `verify`, before the `no` arc, so the loop ends after three fixes; `max_steps` remains the safety net.

**Triage**: route a request to one of several handlers.
```
classify (choice: bug | feature | question) → fix-bug / spec-feature / answer → done
```

**Quality gate**: grade, then publish, revise or start over.
```
draft → grade (score) ─ ≥ 0.8 → publish
                      ├ ≥ 0.5 → revise → grade
                      └ otherwise → draft
```

## 6. Check before exporting

1. `validate_project` returns `ready: true` and no warnings, or only warnings the user accepted.
2. `export_diagram` shows the flow you intended; share it with the user when the design is not trivial.
3. Every step has real instructions: a step created without `skill_markdown` has no Skill file (`Skill not found` blocks export), and Skills created from the editor or opened before being written contain only a placeholder line.
4. The workflow `description` says when to use it, so harnesses pick the exported Skill for the right requests.
