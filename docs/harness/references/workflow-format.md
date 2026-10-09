# Workflow format

A Visage project folder contains:

```
<project>/
  project.json            # id, name, created_at, root_path (managed by Visage)
  workflow.yaml           # the state machine described here
  skills/<step>/SKILL.md  # instructions for each step
  skills/<step>/...       # reference files for that step (PDFs, examples, code)
  references/...          # optional files shared by every step (see shared_references)
  dist/                   # exported plugins (generated)
```

## `workflow.yaml`

```yaml
version: 1
workflow:
  id: blog-post                 # plugin name when exported
  name: Blog post               # display name
  version: 0.1.0                # plugin version
  description: Write, review and publish a blog post from a topic. Use when the user asks for a blog post.
start: draft                    # ID of the initial step
max_steps: 50                   # optional, 1-10000, default 50
shared_references: [references/CONTRACT.md]   # optional: files every step receives
nodes:
  draft:
    type: skill
    label: Draft
    description: Write the first version
    skill: {path: skills/draft/SKILL.md}
    next:
      - goto: review
  review:
    type: skill
    label: Review
    skill: {path: skills/review/SKILL.md}
    evaluation:
      type: choice
      question: Is the draft ready to publish?
      options: [approved, changes, rejected]
    max_attempts: 2
    on_fail: archive
    next:
      - goto: published
        when: output.result == "approved"
      - goto: draft
        when: output.result == "changes"
        label: Revise
      - goto: archive           # no `when`: otherwise
  published:
    type: skill
    label: Published
    terminal: true
    description: The post is ready.
    postcondition: {command: "node scripts/check-post.mjs", message: The post renders without broken links}
  archive: {type: skill, label: Archived, terminal: true}
```

### Root fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | recommended | Format version, `1`. |
| `workflow.id`, `workflow.name`, `workflow.version` | recommended | Plugin name, display name and version. `id` defaults to the project ID. |
| `workflow.description` | recommended | Description of the exported Skill: what it does and when to use it. |
| `start` | to export | ID of the initial step. |
| `max_steps` | no | Limit of step submissions per run, retries included. Default 50. When it is exceeded, the error lists the submissions per step (`Workflow exceeded max_steps (60): analyze 12, fix 11, …`). |
| `shared_references` | no | Project files (relative paths, no `..`) that every step receives as `shared_files` in the exported runner. Use one for the names steps must agree on; see [authoring-guide.md](authoring-guide.md#shared-contract). |
| `nodes` | yes | Map of node ID to node. IDs: 1–80 characters, letters, digits, `-`, `_`. |

Older projects may also contain `harness`, `model` and `reasoning_effort`; they are ignored.

### Node fields

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | Always `skill`. |
| `label`, `description` | all | Text on the canvas and in the exported steps table. |
| `skill.path` | steps | Path of the step's `SKILL.md` inside the project. |
| `terminal` | final states | `true` ends the run. Final states have no Skill, arcs or evaluation. |
| `evaluation` | steps | What the step decides; see below. Optional. |
| `max_attempts` | steps | 1–20, default 1. Consecutive invalid results allowed before `on_fail` (1 means no retry). A valid result resets the count. |
| `on_fail` | steps | Node to go to after the last invalid attempt. Without it the run fails. |
| `next` | steps | Ordered arcs; see below. |
| `postcondition` | final states | `{command, message?, timeout_seconds?}`. A shell command the exported runner runs when the run arrives here; the run completes only when it exits 0. See [Postconditions](#postconditions). |
| `position` | all | Canvas coordinates (editor only). |

## Evaluation

Every evaluated step returns a JSON object with a `result` and a short `reason`. The step may also write files and return other keys, but only `result` chooses the next step.

| `type` | `result` | Typical question |
| --- | --- | --- |
| `predicate` | `true` or `false` | Does the game pass every acceptance test? |
| `choice` | exactly one of `options` (2 or more, unique, non-empty) | Should the draft be approved, revised or rejected? |
| `score` | a number from 0 to 1 | How completely does the result meet the requirements? |

`question` tells the agent what to decide; always write it. A step without `evaluation` is not checked and always follows its arcs (normally a single unconditional arc).

When the result is missing or invalid (wrong type, unknown option, score outside 0–1), the step is tried again with feedback, up to `max_attempts` tries in total (the default 1 means no retry). After the last invalid try the run goes to `on_fail`, or fails when there is none. Example feedback: `output.result must be one of ["approved","changes"]`.

`max_attempts` limits a burst of **consecutive invalid** results, not the number of visits to a step:

- `on_fail` only reacts to invalid results. A valid `false`, `rejected` or low score follows the arcs, never `on_fail`.
- Any valid result resets the count. With `max_attempts: 3`, the sequence `incomplete, incomplete, incomplete, <invalid>` does not reach `on_fail`: the valid results reset the count, so the invalid one is only the first in a row.
- To stop a loop of valid but unwanted results, use an arc on `state.attempts.<step>` (which counts every submission), placed before the arc back into the loop: `when: state.attempts.fix >= 3` → `needs-human`.

## Arcs and expressions

`next` lists arcs in priority order. Each arc has `goto` (target node), an optional `when` and an optional `label` (canvas text). The first arc whose `when` matches is taken; an arc without `when` always matches. Arcs may also carry `source_handle` / `target_handle`, connection points chosen in the editor; they do not affect routing.

`when` uses a small, safe expression language. It never executes code:

```
<path> <operator> <literal>
```

- **path**: `output.<key>...` (the current step's output) or `state.<key>...` with `state.input` (the run input), `state.outputs.<step>.<key>` (earlier outputs), `state.attempts.<step>` (submissions of that step so far, the current one and invalid ones included; `0` is never seen, a step not yet run is `null`). `.length` gives the length of a list or text; list items use numbers (`output.items.0`). Missing paths are `null`.
- **operator**: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in`. `in` / `not in` need spaces around them.
- **literal**: JSON (`"text"`, `0.8`, `true`, `null`, `["a", "b"]`) or single-quoted text (`'text'`).

`<`, `<=`, `>`, `>=` compare numbers with numbers or text with text; any other combination is false. `in` checks membership in a list, or a substring in text.

Routing on the result of each evaluation type:

| Evaluation | Arcs |
| --- | --- |
| predicate | `output.result == true` · `output.result == false` |
| choice | `output.result == "approved"` (one arc per option, or one arc plus an otherwise arc) |
| score | `output.result >= 0.8` · `output.result >= 0.5` · otherwise. Put stricter thresholds first. |

Other expressions are allowed for special cases, such as `state.attempts.fix >= 3` to leave a loop.

## Validation

Saving checks structure; exporting also requires the workflow to be complete.

**Errors** reject the change (nothing is saved):

| Message | Fix |
| --- | --- |
| `Workflow must contain a nodes map` / `Invalid YAML: ...` | Fix the YAML. |
| `Invalid node type: <id>` | Every node needs `type: skill`. |
| `Invalid identifier` | Use letters, digits, `-`, `_` in node IDs. |
| `Node <id> needs a SKILL.md path` | Steps need `skill.path` ending in `SKILL.md`. |
| `Skill path escapes the project for <id>` | Keep Skill paths inside the project. |
| `Invalid transition target from <id>` | `goto` must name an existing node. |
| `Final node <id> cannot have transitions` / `cannot have an evaluation` | Remove them, or make the node a step. |
| `Node <id>: Unsupported transition expression: ...` | Rewrite `when` as `<path> <operator> <literal>`. |
| `Node <id>: Unsupported transition value: <text>` | Quote text literals: `"approved"`. |
| `Node <id>: Right side of 'in' must be a list or string` | Use a list after `in` / `not in`. |
| `Invalid source_handle on transition from <id>: ...` / `target_handle` | Use editor connection points such as `bottom-2`, or remove the field. |
| `Transitions of <id> must be a list` | `next` is a list of arcs. |
| `start must be a node ID` / `An empty workflow cannot have a start node` | Fix `start`. |
| `Node <id>: evaluation must be an object with a type` / `evaluation has unknown keys: ...` / `evaluation question must be text` / `choice options must be a list` | Use `{type, question, options}` only. |
| `Node <id>: evaluation type must be one of predicate, choice, score` | Fix `evaluation.type`. |
| `Node <id>: choice options must be unique` / `must be non-empty text` | Fix the options. |
| `Node <id>: options are only used by choice evaluations, not <type>` | Remove `options`. |
| `Node <id>: max_attempts must be an integer between 1 and 20` | Fix the number. |
| `Node <id>: on_fail must reference an existing node` | Point it at an existing node or remove it. |
| `max_steps must be an integer between 1 and 10000` | Fix the number. |

| `Node <id>: only final nodes can have a postcondition` / `postcondition must be a map with a command` / `postcondition has unknown keys: ...` / `postcondition command must be non-empty text` / `postcondition timeout_seconds must be an integer between 1 and 3600` | Use `{command, message?, timeout_seconds?}` on a final node. |
| `shared_references must be a list of project file paths` / `must not repeat a file` / `Shared reference must be a relative path inside the project: <path>` / `Shared reference escapes the project: <path>` | List relative project paths, each once. |

**Readiness issues** are saved as warnings and block export:

- `Start node must exist`
- `Start node <id> is a final state, so the run would end at once; use set_start on the first step`
- `Workflow needs a terminal node`
- `Skill not found for <id>: <path>`
- `Node <id>: a choice evaluation needs at least two options`
- `Shared reference not found: <path>`

**Warnings** do not block anything, but usually point at a broken design:

- `Node <id> has no transitions`: a step that leads nowhere fails the run.
- `Node <id>: no arc for result <value>` (for scores: `no arc for result scores such as 0.65`): that result has nowhere to go and fails the run.
- `Node <id>: arcs after the unconditional arc to <target> are never used`: move the otherwise arc to the end.
- `Node <id> is unreachable`: nothing leads to it from the start.
- `Node <id>: "<when>" refers to unknown step "<step>", so it is always null`: a misspelled step in `state.attempts.<step>`, `state.outputs.<step>` or `state.feedback.<step>`. The arc would never match (or always, with `!=`).
- `Node <id>: "<when>" uses unknown state key "<key>"`: `state.` is followed by `input`, `outputs`, `attempts`, `feedback` or `last_output`.
- `Node <id>: unknown keys <keys>`: a misspelled field, or text cut at a comma inside `{...}`; quote text that contains commas.
- `Node <id>: output_schema is no longer used ...` / `checks is no longer used ...`: old format; set an evaluation instead.

## Postconditions

A workflow can only check what its steps report: a step that says `0.92, ready to hand over` moves the run on even when the product is broken. A **postcondition** on a final state makes the exported runner check the product itself before the run counts as `completed`:

```yaml
delivered:
  type: skill
  terminal: true
  description: A playable game was delivered.
  postcondition:
    command: node tests/smoke.mjs        # run with a shell, from the working directory
    message: The game starts from its real entry point
    timeout_seconds: 120                 # optional, 1-3600, default 300
```

- The command runs when the run arrives at that final state, from the agent's working directory, with `VISAGE_ARTIFACT_DIR` (the run's artifact folder), `VISAGE_SHARED_DIR` (the exported `shared/` folder, holding `shared_references` at their project paths), `VISAGE_RUN_DIR` and `VISAGE_RUN_ID` set. Write them as `$VISAGE_SHARED_DIR` in POSIX shells; a Node script reading `process.env` works on every platform.
- Exit code 0 completes the run. Anything else, or a timeout, fails it with `Postcondition of <node> failed: <message> (exited with N)`. The reply and `history.jsonl` carry `postcondition: {node, command, passed, exit_code, output, message}`, with the last 4000 characters of the command's output.
- Put postconditions on success states (`delivered`), not on states such as `needs-human` that already report a failure.
- Prefer a check that ships with the plugin: list `references/check.mjs` in `shared_references` and use `command: node "$VISAGE_SHARED_DIR/references/check.mjs"`. A check written by a step can be weakened by the same agent it is meant to check. It must not need tools the harness lacks; see [authoring-guide.md](authoring-guide.md#verifying-a-runtime-artifact).
- `test_workflow` scenarios do not run postconditions: they test routing only.

