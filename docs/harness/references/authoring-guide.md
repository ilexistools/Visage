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

The exported runner gives the agent, for every step: the step's Skill (`step_file`), the run `input`, the outputs of earlier steps (`previous_outputs.<step>`), the step's reference files (`resources_dir`), any shared contract files (`shared_files`) and a folder for files it produces (`artifact_dir`). The agent sees nothing else: not the conversation in which the workflow was designed, not the other steps' Skills, not what the user meant.

**A Skill is a procedure, not a prompt.** "Review the draft and decide if it is ready" is a prompt: every agent will review differently, stop at a different depth and decide on a different bar. A Skill says how the work is done, what good looks like and how to prove it. Write it the way you would brief a capable colleague who has never seen the project and cannot ask you questions.

### What a Skill contains

| Section | What it says |
| --- | --- |
| **Goal** | What this step delivers and why: what came before it and what the next step needs from it. |
| **Inputs** | The exact keys and files to read: `input.topic`, `previous_outputs.draft.draft_file`, `DESIGN.md` in the artifact folder, the shared contract. What to do when one is missing or ambiguous. |
| **Procedure** | Numbered steps with the concrete method of each: what to open, what to compare with what, what to run. Each step should be something an agent can do and know it has done. |
| **Quality criteria** | A definition of done that can be checked item by item, ideally with thresholds (word counts, test results, required sections). |
| **Decision** (evaluated steps) | When each result applies, in the words of the `question` and `options`, including borderline cases. For scores, what 0.2, 0.5 and 0.8 mean. |
| **Failure handling** | What to do when inputs are missing, the method cannot run, or the evidence is incomplete. Never invent data to fill a gap: report it in the output. |
| **Output** | The files to write (name and folder) and the JSON object to return, with every key later steps read. |

Domain knowledge that does not fit in a procedure (style guides, checklists, templates, good and bad examples) goes in reference files next to the `SKILL.md` (`write_file`), and the Skill names them in the step where they are used.

### Example

````markdown
# Review the draft

## Goal

Decide whether the blog post draft is ready to publish. The draft step wrote it from the brief;
if it is not ready, the draft step gets it back with your list of issues, so every issue must be
specific enough to fix without asking you anything.

## Inputs

- `input.topic`: the brief the post must answer.
- `previous_outputs.draft.draft_file`: the draft, a Markdown file in the artifact folder.
- `previous_outputs.review.issues`, if present: the issues you raised last time. Check each one again.
- `checklist.md` in this step's folder: the editorial checklist.

If the draft file is missing or empty, do not review anything: return `rejected` with the reason
"draft file missing".

## Procedure

1. Read the brief, then the whole draft once without judging, to understand what it tries to say.
2. Go through `checklist.md` item by item. For each item, note pass or fail and quote the passage
   that shows it (a heading, a sentence, a number).
3. Check every factual claim that names a product, version, date or number against the sources the
   draft cites. A claim without a source counts as an issue.
4. Count the words of the body (without code blocks). The target is 800 to 1200 words.
5. If there were earlier issues, confirm each one is fixed; an issue that comes back is listed again.
6. Write `review.md` in the artifact folder: one line per checklist item with its verdict and
   evidence, then the list of issues, most important first.

## Quality criteria

The review is done when:

- every checklist item has a verdict and a quoted piece of evidence;
- every issue names where it is (section or quote), what is wrong and what a fix looks like;
- the decision below follows from the verdicts, not from an overall impression.

## Decision

- `approved`: every checklist item passes and no factual claim is unsupported.
- `changes`: the draft answers the brief, but one or more items fail and each can be fixed by
  editing. List every one in `issues`.
- `rejected`: the draft does not answer the brief (wrong topic, wrong audience), or it is missing.
  Say why in `reason`; rewriting is cheaper than fixing.

When in doubt between `approved` and `changes`, choose `changes`: an unnecessary revision costs
less than publishing a mistake.

## Output

Write `review.md` in the artifact folder, then finish with one JSON object:

```json
{"result": "changes", "reason": "Two claims lack sources and the conclusion is missing.", "issues": ["Section 2: the 40% figure has no source; cite the survey or remove it.", "No conclusion: add a closing section that answers the brief's question."], "review_file": "review.md"}
```
````

The same step written as a prompt, which validation reports as a shallow Skill:

```markdown
# Review

Review the draft and check that it is good. Return approved, changes or rejected.
```

It names no input, no method, no bar and no output, so each run invents its own.

### Guidelines

- **Inputs**: name the exact keys to read (`input.topic`, `previous_outputs.review.issues`). Keys of earlier outputs are whatever those steps returned, so keep them consistent across Skills.
- **Decision**: for evaluated steps, describe when each result applies, using the same words as the `question` and the `options`.
- **Output**: end with the JSON the step returns. Evaluated steps must include `result` and should include a short `reason`; add the keys later steps need (`issues`, file names). Steps without evaluation can return any object, such as `{"plan_file": "PLAN.md"}`.
- **Files**: say where files go. Reference files the step needs (guidelines, templates, examples) go next to its `SKILL.md` with `write_file`, and the Skill names them.
- **Self-contained**: do not mention Visage, the runner or other steps' instructions; the orchestrator Skill handles the protocol.
- **One place for files**: steps write files to the artifact folder and later steps read them from there (`the design in DESIGN.md in the artifact folder`). Do not mix the artifact folder with the project root or the working directory: a file one step writes in one place is missing for a step that reads the other.
- **Language**: write the Skill in the language the user works in; the checks below understand section names in English, Portuguese and Spanish.

### Check each Skill before the next

Write one Skill at a time, then reread it as the agent that will run it, knowing nothing else:

1. Could I do this step from this file alone, and would two runs do it the same way?
2. Do I know exactly when I am done, and how good is good enough?
3. For an evaluated step: is every result reachable by a rule, not by mood?
4. Is every file and key I read produced by an earlier step, under the same name?

`upsert_node` and `validate_project` warn about a **shallow Skill**: under 150 words, no numbered procedure, no quality-criteria section, no JSON example, or an evaluated step whose Skill never names `result` or one of its outcomes. Treat that warning like a failing test.

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
3. Every step has real instructions: a step created without `skill_markdown` has no Skill file (`Skill not found` blocks export), Skills created from the editor or opened before being written contain only a placeholder line, and no step has a `shallow Skill` warning.
4. The workflow `description` says when to use it, so harnesses pick the exported Skill for the right requests.
5. Names shared between steps live in one [shared contract](#shared-contract), and success states that deliver a product have a postcondition.
6. Remember what `test_workflow` proves: the workflow **routes** as designed. Only a postcondition, or a verification step that runs the real artifact, says whether the product works.
