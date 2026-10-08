# Visage

Visage is a local visual editor and runtime for workflows that route AI Skills through explicit state transitions.

The current version is **0.1.0**. It runs in a local browser with a Python backend. Projects start with an empty canvas; add Skill nodes and configure a workflow before running it.

## Quick start

Requires Node.js 20+ and Python 3.11+. Install [uv](https://docs.astral.sh/uv/) if it is not already available.

```bash
cd backend
uv sync --extra dev
uv run uvicorn vasm.api:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Click **New project** to open a blank canvas. Add Skill nodes, configure transitions and a final state, then save and run the workflow.

## What is implemented

- Visual workflow canvas with one Skill node type; initial and final states are markers on Skill nodes. Arc labels are illustrative and separate from transition conditions.
- Inspector for node label, description, arc text and state, with a Markdown Skill editor and resource file imports.
- Compact editor layout with resizable, collapsible sidebars that can dock on either side of the canvas, plus icon-only node actions in the topbar.
- Workflow validation for Skill paths, node targets and restricted transition expressions.
- Codex CLI, Claude Code and generic CLI adapters, selected once for the whole workflow.
- Persisted run state, append-only events, checkpoints and artifact metadata.
- Automatic and single-step execution, pause after the current node and resume.
- Run timeline, state view, artifact preview and node inspector.
- Recovery of runs interrupted while the backend was stopped; the current node is ready to retry.

Workflow definitions live in `data/projects/<project-id>/workflow.yaml`. New projects contain only an empty workflow; add Skill Markdown and supporting files through the editor. SQLite catalogs projects and runs in `data/vasm.sqlite`. Detailed run records live in `data/runs/<run-id>/` as JSON and JSONL. `data/` is ignored by Git.

### Harness configuration

A workflow selects one global `harness` (`generic_cli`, `codex` or `claude`) for all non-final Skill nodes. Each non-final Skill needs a `skill.path`; with `generic_cli`, it also needs a command array. Final state nodes share the same Skill node type and end execution without invoking a harness. The process runs in the project directory and receives the Skill text on standard input. It also receives `VASM_CONTEXT_JSON`, `VASM_RUN_ID`, `VASM_NODE_ID` and `VASM_ARTIFACT_DIR` environment variables. JSON written to standard output becomes the node output; other text is wrapped as `{ "text": "..." }`. Files written to the artifact directory are indexed after the node completes.

```yaml
my_task:
  type: skill
  skill: {path: skills/my-task/SKILL.md}
  next:
    - goto: review
```

Set `harness: codex` (or `claude`, `generic_cli`) at the workflow root to choose the runner for all Skills.

`codex` uses `codex exec`; `claude` uses `claude --print`. Install and authenticate those CLIs separately before using them. These adapters invoke local processes with the host user's permissions. The backend binds to `127.0.0.1` in the quick start because project commands can access local files.

Transition conditions support paths under `output` and `state`, with `==`, `!=`, `<`, `<=`, `>` or `>=` against literals. They do not execute arbitrary code.

## API and development

The API is documented interactively at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs). Main routes include `/api/projects`, `/api/projects/{id}/workflow`, `/api/projects/{id}/runs`, `/api/runs/{id}`, `/api/runs/{id}/start`, `/api/runs/{id}/step`, `/api/runs/{id}/pause` and `/api/runs/{id}/resume`.

```bash
cd backend && uv run pytest -q
cd frontend && npm run build
```

The workflow editor supports local execution through the selected harness. Artifact editing, real-time push events, multi-user access, scheduled jobs and cloud execution are not included in this version.
