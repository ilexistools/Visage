# Authoring guide

How to turn a process into a Visage workflow that agents run reliably.

## 1. Find the steps

- Give each step one responsibility that an agent can finish in one go: *write the plan*, *implement*, *review*, *fix*. Split a step when its instructions describe two unrelated jobs; merge steps that always run together and never decide anything.
- Put a decision wherever the path can change: a review, a test, a triage. That step gets an evaluation; the others just produce files.
- Name the end states after their outcome (`published`, `rejected`, `needs-human`), with a `description` the agent can report to the user. The description is the same for every run, so it says where the run ended, not whether the work is good: give success states a [postcondition](workflow-format.md#postconditions) that checks the product.
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
- **One place for files**: steps write files to the artifact folder and later steps read them from there (`the design in DESIGN.md in the artifact folder`). Do not mix the artifact folder with the project root or the working directory: a file one step writes in one place is missing for a step that reads the other.

### Shared contract

Skills are written one at a time, so names drift: one step invents a test hook `window.__TEST_TICK` while another requires `window.__GAME__`, or one writes `ACCEPTANCE-CHECKLIST.md` that the next reads as `ACCEPTANCE.md`. Validation cannot tell that two different names mean the same thing. Prevent it instead:

1. Write one contract file, for example `references/CONTRACT.md`, listing every name more than one step depends on: file names in the artifact folder, test hooks and their members, data formats, entry points.
2. Add it to the workflow: `configure_workflow` with `shared_references: ["references/CONTRACT.md"]`. Every step receives it as `shared_files`, and the orchestrator tells the agent that it wins over anything a step invents.
3. In each Skill, refer to the contract by name (`use the hook named in the contract`) instead of repeating or inventing names.

### Verifying a runtime artifact

A step that checks a web page, a game or a CLI must name a method the harness can actually run. An exported step may rely on Node.js 20+, a shell and the agent's file tools (read, write, edit, search). It may **not** assume browser automation (Playwright, Chrome DevTools), network access or any globally installed CLI. Conformance runs give Claude Code only `Bash`, `Read`, `Write`, `Edit`, `Glob` and `Grep` ([testing.md](testing.md)).

- **Run the real entry point.** Load the page's own script with `node:vm` and stubbed globals (`document`, `window`, `requestAnimationFrame`, key events), start it the way a browser would, send the inputs a player sends and assert on what changes. Calling internal functions exposed for testing proves nothing about the entry point; neither does a harness that edits the artifact (for example removing `requestAnimationFrame(loop)`) before testing it.
- **Name the method in the Skill**: *"run `node tests/smoke.mjs`; it must exit 0"*, not *"test it in a browser"*. "If the tool is unavailable, report it" is not a method: when the verdict requires that tool, the step fails on every visit and the loop runs until `max_steps`.
- **Do not let the checked agent own the check.** Ship the smoke test as a shared reference and run it as the success state's [postcondition](workflow-format.md#postconditions), so a passing score cannot complete a run whose product does not start.

## 4. Handle failure and loops

- `max_attempts: 2` or `3` on evaluated steps absorbs an occasional malformed answer (it counts consecutive invalid tries, so `2` means one retry); the retry includes the validation error. A valid result resets the count.
- `on_fail` sends a step that keeps answering badly (an invalid result, not a negative one) somewhere useful: a fix step, or a `needs-human` end state. Without it the run fails. It never catches a valid but unwanted result such as `incomplete`: route that with an arc.
- Loops (review → fix → review) are normal. Give them an explicit exit: an arc such as `when: state.attempts.fix >= 3` → `needs-human`, placed before the arc back into the loop. `state.attempts.<step>` counts every submission of that step, invalid ones included. `max_steps` is only a safety net: reaching it fails the run, and the error lists how many submissions each step used.
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
5. Names shared between steps live in one [shared contract](#shared-contract), and success states that deliver a product have a postcondition.
6. Remember what `test_workflow` proves: the workflow **routes** as designed. Only a postcondition, or a verification step that runs the real artifact, says whether the product works.
