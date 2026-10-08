# Exported plugins

`export_plugin` turns a workflow into a plugin that runs without Visage. It works in Claude Code and Codex, and its Skill can be given to any agent that can run shell commands. The runner needs Node.js 20 or later.

## Contents

```
<plugin>/
  .claude-plugin/plugin.json      # Claude Code manifest
  .codex-plugin/plugin.json       # Codex manifest
  README.md                       # description, Mermaid diagram of the flow, install notes
  skills/<plugin>/
    SKILL.md                      # orchestrator: the only Skill a harness discovers
    agents/openai.yaml            # Codex display metadata
    workflow.json                 # the state machine (no editor-only fields)
    scripts/flow.mjs              # runner, no dependencies
    nodes/<step>/STEP.md          # each step's Skill (frontmatter removed) and its reference files
```

Step Skills are renamed `STEP.md` and kept under `nodes/` so harnesses cannot run a step on its own or out of order; only the orchestrator Skill is discoverable. Its `description` is the workflow description.

## Installing

- **Claude Code**: `claude --plugin-dir <plugin>` for one session, or add the folder to a plugin marketplace.
- **Codex**: add the folder as a local plugin, or copy `skills/<plugin>` to `~/.codex/skills/`.
- **Other agents**: give the agent `skills/<plugin>/SKILL.md` and let it run shell commands.

The zip (`<plugin>-<version>.zip`) contains the same folder for sharing.

## Run protocol

The orchestrator Skill tells the agent to drive the run with the runner. Commands print JSON on standard output:

| Command | Purpose |
| --- | --- |
| `node flow.mjs start --input '<JSON or text>'` (or `--input-file f.json`, `--run <id>`) | Start a run and print the first step. |
| `node flow.mjs submit --output-file <file>` (or `--output '<json>'`, or standard input; `--node <id>` guards against submitting to the wrong step) | Submit the current step's output and print the next step. |
| `node flow.mjs next` | Print the current step again. |
| `node flow.mjs status` | Show status, outputs and attempt counts. |
| `node flow.mjs list` / `describe` | List runs / print the workflow. |

`next`, `submit` and `status` act on `--run <id>`, by default the latest run; `start --run <id>` names a new run. All commands accept `--state-dir <dir>`. Run IDs use letters, digits, `-` and `_`.

### Step instruction

`start`, `next` and `submit` print the step to execute:

```json
{
  "status": "awaiting_output",
  "run_id": "run-5565d2ef36",
  "node": "review",
  "label": "Review",
  "description": "",
  "attempt": 1,
  "max_attempts": 2,
  "step_file": "<plugin>/skills/blog-post/nodes/review/STEP.md",
  "resources_dir": "<plugin>/skills/blog-post/nodes/review",
  "feedback": [],
  "input": { "topic": "MCP servers" },
  "previous_outputs": { "draft": { "draft_file": "post.md" } },
  "output_contract": {
    "type": "choice",
    "question": "Ready?",
    "options": ["approved", "changes"],
    "result": "exactly one of [\"approved\",\"changes\"]",
    "example": { "result": "approved", "reason": "One or two sentences explaining the result." }
  },
  "artifact_dir": "<state-dir>/run-5565d2ef36/artifacts",
  "output_file": "<state-dir>/run-5565d2ef36/outputs/002-review.json",
  "submit": "node \"<plugin>/skills/blog-post/scripts/flow.mjs\" submit --run \"run-5565d2ef36\" --state-dir \"<state-dir>\" --output-file \"<state-dir>/run-5565d2ef36/outputs/002-review.json\""
}
```

The agent reads `step_file`, does the work using `input`, `previous_outputs` and `resources_dir`, saves files in `artifact_dir`, writes its JSON output to `output_file` (the folder already exists) and runs `submit` exactly as printed. `output_contract` appears only for evaluated steps.

### Replies to `submit`

The reply adds `decision`, `evaluated_node` and `errors` to the next instruction:

- `decision: "next"`: the run moved on to `next_node`. When `errors` is empty the output passed; when it is not, the step used up its tries and the run followed `on_fail`. The reply is the next step, or a completed/failed summary when the next node is a final state.
- `decision: "retry"`: the result was invalid. The same step comes back with `attempt` increased and `feedback`, e.g. `["output.result must be one of [\"approved\",\"changes\"]"]`; fix the output and submit again.
- `status: "completed"`: a final state was reached (possibly through `on_fail`; check `node` and `final_state`). The reply has `outputs` of every step, `artifact_dir` and, when the final state has a description, `final_state`.
- `decision: "failed"` with `status: "failed"`: an invalid result after the last try without `on_fail`, a result without an arc (`No transition matched for node <id>`), or `max_steps` exceeded. The reply has `error`; the run cannot continue.

Errors in using the runner print `{"status": "error", "error": "..."}` and exit with code 1, for example `Run is completed; nothing to submit.` or `Current step is review, not draft.`

### Output parsing

The submitted text is read as JSON. A fenced ```` ```json ```` block or the outermost `{...}` in surrounding prose is also accepted; JSON that is not an object becomes `{"value": ...}`, and anything else `{"text": "..."}`; both fail an evaluated step because `result` is missing.

## Run state

Runs are kept in `.visage/runs/<plugin>/<run-id>/` under the working directory (`--state-dir` or `VISAGE_STATE_DIR` change it): `state.json`, `history.jsonl` (one `start` or `submit` event per line, with the decision, errors and result of each submission; see [testing.md](testing.md)), every submitted output in `outputs/` and the step artifacts in `artifacts/`. A run can be continued later with `next`, even from another session.
