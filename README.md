# Visage

Visage is a visual editor for workflows that route agent Skills through explicit state transitions. Each node is a Skill, each output is evaluated before the workflow advances, and a finished workflow is exported as a plugin that Codex or Claude Code runs on its own.

The current version is **0.2.0**. Everything runs in one Node.js process that serves the editor, a REST API and an MCP server, and the whole app is itself distributed as a Claude Code / Codex plugin.

## Quick start

Requires Node.js 20+.

### As a plugin (recommended)

```bash
cd server
npm install
npm run package          # builds dist/visage/ and dist/visage-<version>.zip
claude --plugin-dir dist/visage
```

The plugin registers the `visage` MCP server and a `visage` Skill. Ask the agent to create a workflow or to "open the Visage editor": the server also serves the editor at [http://127.0.0.1:4317](http://127.0.0.1:4317). In Codex, add `server/dist/visage` as a local plugin; it uses `.codex-plugin/plugin.json` and `.codex-mcp.json`.

### Standalone editor

```bash
cd server && npm install && npm run build
node build/visage.js --open
```

### Development

```bash
cd server && npm install && npm run dev       # API + MCP on :4317, reloads on change
cd frontend && npm install && npm run dev     # editor with hot reload on :5173, proxied to :4317
```

## How it works

- **Projects** are folders containing `project.json`, `workflow.yaml`, one `skills/<node>/SKILL.md` per step and any imported references. The catalog of project locations is `~/.visage/projects.json` (override with `VISAGE_DATA_DIR`); projects created without a location go to `~/.visage/projects/`.
- **Editor**: canvas with one Skill node type; initial and final states are markers on nodes. The Inspector edits label, description, arc labels and conditions, the evaluation gate, the Skill Markdown and resource imports.
- **MCP**: the same process speaks MCP over stdio (`--stdio`, used by the plugin) and over Streamable HTTP at `http://127.0.0.1:4317/mcp`. When several harness sessions start the server, the first one serves the editor and the others reuse it.
- **Export**: the **Export plugin** button, `POST /api/projects/{id}/export` or the `export_plugin` tool produce a plugin that does not need Visage.

### Workflow format

```yaml
version: 1
workflow: {id: review-flow, name: Review flow, version: 0.1.0, description: Used as the exported Skill description}
start: draft
max_steps: 50               # stops runaway loops
nodes:
  draft:                    # no evaluation: produces files, always continues
    type: skill
    skill: {path: skills/draft/SKILL.md}
    next:
      - goto: review
  review:
    type: skill
    skill: {path: skills/review/SKILL.md}
    evaluation:
      type: choice          # predicate | choice | score
      question: Is the draft ready to publish?
      options: [approved, changes, rejected]
    max_attempts: 3         # an invalid result is retried with feedback
    on_fail: draft          # after the last invalid attempt; omit to stop the run
    next:
      - goto: done
        when: output.result == "approved"
      - goto: draft
        when: output.result == "changes"
      - goto: archive       # no `when`: otherwise
  done: {type: skill, terminal: true}
  archive: {type: skill, terminal: true}
```

Every evaluated step returns `{"result": ..., "reason": "..."}`:

| Type | `result` | Arcs |
| --- | --- | --- |
| `predicate` | `true` or `false` | `output.result == true`, `output.result == false` |
| `choice` | exactly one of `options` | `output.result == "approved"` |
| `score` | a number from 0 to 1 | `output.result >= 0.8` (also `>`, `<`, `<=`) |

Steps may also write files and return other keys; only `result` chooses the next step. In the editor, the Inspector sets the type, question and options, and each arc gets a matching selector (yes/no, an option, a score threshold or *otherwise*). Validation warns when a result has no arc. Missing start or final nodes and missing Skill files are saved as warnings and only block export. The older `output_schema` and `checks` fields are ignored with a warning.

`when` expressions are `<path> <operator> <literal>` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in`; paths start with `output.` or `state.`) and never execute code.

### MCP tools

`list_projects`, `create_project`, `delete_project`, `get_workflow`, `put_workflow`, `configure_workflow`, `upsert_node`, `remove_node`, `set_transitions`, `set_start`, `validate_project`, `list_files`, `read_file`, `write_file`, `export_plugin` and `open_editor`.

To connect a harness without installing the plugin:

```bash
claude mcp add visage -- node /path/to/server/build/visage.js --stdio
codex mcp add visage -- node /path/to/server/build/visage.js --stdio
```

### Exported workflow plugins

An export writes `<project>/dist/<plugin>/` and a zip, with `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`:

- `skills/<plugin>/SKILL.md` is the only discoverable Skill. It tells the agent to drive the run with `scripts/flow.mjs`.
- `scripts/flow.mjs` (Node.js only, no dependencies) owns the state machine: `start`, `next`, `submit`, `status`. It evaluates each submitted output with the same engine as the editor and returns the next step, a retry with feedback, or the final result. Run state is kept in `.visage/runs/<plugin>/` under the working directory.
- Node Skills are copied with their resources to `nodes/<node>/STEP.md`, so the harness cannot run them out of order.

Try one with `claude --plugin-dir <project>/dist/<plugin>`.

## API and development

Routes: `/api/health`, `/api/projects`, `/api/projects/{id}` (rename, delete), `/api/projects/{id}/workflow`, `/api/projects/{id}/validate`, `/api/projects/{id}/files[/path]`, `/api/projects/{id}/export`, `/api/projects/{id}/export.zip` and `/api/folder-picker`. The server binds to `127.0.0.1` and rejects requests whose `Host` or `Origin` is not local, because the API writes project files.

```bash
cd server && npm test && npm run typecheck
cd frontend && npm run build
```

Source layout: `server/src/engine.ts` (expressions, schema checks, transitions; shared with the exported runner), `workflow.ts` (validation), `store.ts` and `projects.ts` (catalog and files), `exporter.ts`, `mcp.ts`, `http.ts`, `main.ts`, and `runner/flow.ts` (bundled to `flow.mjs`). `build.mjs` bundles the server into a single `visage.js` with esbuild.
