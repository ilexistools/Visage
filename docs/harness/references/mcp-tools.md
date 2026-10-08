# Visage MCP tools

The `visage` MCP server exposes 18 tools. Every result is JSON text, except `read_file` and `export_diagram`, which return plain text. A failed call returns an error result whose text says what is wrong (for example `Node not found: nope`); nothing is changed when a call fails.

Changes are written to disk immediately and are visible in the visual editor. Several sessions can use Visage at the same time: edits to one project are serialised with a lock, but the last edit wins.

## Connecting

| Transport | How |
| --- | --- |
| stdio (plugin, or `claude mcp add` / `codex mcp add`) | `node <visage>/server/visage.js --stdio` |
| Streamable HTTP | `http://127.0.0.1:4317/mcp` while Visage is running |

Options: `--port N` (default 4317, or `VISAGE_PORT`), `--open` (open the editor in the browser), `--no-ui` (MCP only, no editor). The project catalog is `~/.visage/projects.json`; set `VISAGE_DATA_DIR` to use another folder. In stdio mode the same process also serves the editor; when another Visage already serves it with the same data folder, that one is reused.

## Identifiers and paths

- `project_id` and `node_id`: 1–80 characters, letters, digits, `-` and `_`, starting with a letter or digit.
- File `path` values are relative to the project folder and use `/`. Paths that leave the project (`..`, absolute paths, symbolic links pointing outside) are rejected.

## Projects

### `list_projects`
No arguments. Returns the projects, newest first:
```json
[{ "id": "blog-post", "name": "Blog post", "created_at": "2026-10-08T18:28:48.581Z", "root_path": "/Users/me/.visage/projects/blog-post" }]
```

### `create_project`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string, required | Also the folder name. Must be unused. |
| `name` | string, required | Display name, not empty. |
| `parent_path` | string | Existing folder that will contain the project folder (`~` allowed). Default `~/.visage/projects`. Cannot be inside another project, and the project folder must not exist yet. |

Creates `project.json` and an empty `workflow.yaml`. Returns the project (same shape as in `list_projects`).

### `delete_project`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string, required | |
| `confirm` | boolean | Must be `true`; otherwise the call fails with `Pass confirm=true to delete the project and all its files`. |

Permanently deletes the project folder, including Skills and exports. Refused when the folder contains another project. Returns `{ "id": "...", "status": "deleted" }`.

## Workflow

Most workflow tools return the saved workflow and its warnings:
```json
{ "workflow": { "version": 1, "workflow": { "id": "blog-post", "name": "Blog post", "version": "0.1.0" }, "start": "draft", "nodes": { "...": {} } },
  "warnings": ["Workflow needs a terminal node", "Node draft has no transitions"] }
```
Warnings never block saving. Structural problems (an arc to a missing node, an invalid expression, a bad evaluation) make the call fail and nothing is saved. See [workflow-format.md](workflow-format.md) for every error and warning.

### `get_workflow`
`project_id`. Returns `{ "source": "<workflow.yaml text>", "workflow": {...}, "warnings": [...] }`.

### `put_workflow`
`project_id`, `source` (complete YAML). Replaces the whole workflow after validation. Use it for large rewrites only, starting from the `source` returned by `get_workflow`; prefer the targeted tools below.

### `configure_workflow`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string, required | |
| `name` | string | Display name of the workflow and of the exported Skill. |
| `description` | string | Becomes the exported Skill's description, which harnesses use to decide when to run it. Say what the workflow does and when to use it. |
| `version` | string | Plugin version, e.g. `1.2.0`. |
| `max_steps` | integer 1–10000 | Maximum submissions per run (default 50) to stop endless loops. Retries count. |

### `upsert_node`
Creates the node when `node_id` is new, otherwise changes only the fields you pass.

| Argument | Type | Notes |
| --- | --- | --- |
| `project_id`, `node_id` | string, required | |
| `label` | string | Name shown on the canvas. Defaults to `node_id` on creation. |
| `description` | string | One line shown under the label and in the exported steps table. |
| `skill_markdown` | string | Full instructions for the step; written to the node's Skill file after the workflow change is validated. |
| `skill_path` | string | Skill file, must end in `SKILL.md` and stay in the project. Default `skills/<node_id>/SKILL.md`. |
| `terminal` | boolean | `true` makes it a final state and deletes its arcs and evaluation (its Skill file is kept but unused). `false` turns it back into a step; set its arcs and evaluation again. |
| `evaluation` | object or `null` | `{ "type": "predicate" \| "choice" \| "score", "question": "...", "options": ["..."] }`; `options` only for `choice`. `null` removes the evaluation. |
| `max_attempts` | integer 1–20 | Total tries per visit when the result is invalid, each retry with feedback. Default 1 (no retry). |
| `on_fail` | string | Node to go to after the last invalid attempt; `""` clears it (the run then stops). |
| `position` | `{x, y}` | Canvas position. New steps are placed in a row; the editor places nodes without a position. |

The first step created becomes the start node (a final state never does). Returns `{ "node_id": "...", "created": true|false, "workflow": {...}, "warnings": [...] }`.

Example, a review step that decides between three options:
```json
{ "project_id": "blog-post", "node_id": "review", "label": "Review",
  "description": "Check the draft against the brief",
  "skill_markdown": "# Review\n\nRead the draft in previous_outputs.draft.draft_file ...",
  "evaluation": { "type": "choice", "question": "Is the draft ready to publish?", "options": ["approved", "changes", "rejected"] },
  "max_attempts": 2 }
```
A choice with fewer than two options can be saved while you build it, but blocks export.

### `remove_node`
`project_id`, `node_id`. Removes the node and every arc and `on_fail` pointing to it. When it was the start node, the first remaining node becomes the start. The Skill file stays on disk.

### `set_transitions`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id`, `node_id` | string, required | Not allowed on final states. |
| `transitions` | array, required | `[{ "goto": "<node_id>", "when": "<expression>", "label": "<canvas text>" }]`. Replaces all outgoing arcs. |

The first arc whose `when` matches is taken; an arc without `when` always matches, so put it last as the "otherwise" arc. An empty `when` (`""`) is rejected: leave the key out instead. Connection points pinned in the editor are kept for arcs that still go to the same node.

Example for the review step above:
```json
{ "project_id": "blog-post", "node_id": "review", "transitions": [
  { "goto": "publish", "when": "output.result == \"approved\"" },
  { "goto": "draft", "when": "output.result == \"changes\"", "label": "Revise" },
  { "goto": "archive" } ] }
```

### `set_start`
`project_id`, `node_id`. Makes the node the initial state.

### `validate_project`
`project_id`. Returns whether the workflow can be exported:
```json
{ "ready": false,
  "errors": ["Workflow needs a terminal node; Skill not found for review: skills/review/SKILL.md"],
  "warnings": ["Workflow needs a terminal node", "Skill not found for review: skills/review/SKILL.md", "Node review: no arc for result changes"] }
```
`errors` has at most one entry, which joins every issue that blocks export with `; `. Those issues are also listed one by one in `warnings`, together with the design warnings. `ready: true` with warnings still exports, but a warning such as `no arc for result changes` means a run that returns `changes` fails. Fix warnings unless the user accepts them.

## Files

### `list_files`
`project_id`. Returns project file paths, sorted (`["skills/draft/SKILL.md", "workflow.yaml"]`). `project.json` and the `dist/`, `runs/`, `.git/`, `.visage/` and `node_modules/` folders are left out.

### `read_file`
`project_id`, `path`. Returns the file text (up to 2 MB). Reading a Skill path under `skills/` that the workflow references but that does not exist yet creates it from a one-line placeholder.

### `write_file`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id`, `path`, `content` | string, required | Creates folders as needed and replaces existing files. `workflow.yaml` and `project.json` are refused: use the workflow tools. |
| `encoding` | `"utf-8"` (default) or `"base64"` | Use base64 for binary files such as PDFs. Up to 25 MB. |

Returns `{ "path": "...", "size": 1234 }`. Use it for Skills and step reference files; do not write `workflow.yaml` with it.

### `delete_file`
`project_id`, `path`. Deletes one file. `workflow.yaml`, `project.json`, folders and any Skill used by a step are refused (`skills/draft/SKILL.md is used by a step; change the step's Skill first`). Returns `{ "path": "...", "status": "deleted" }`.

## Output

### `export_plugin`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string, required | The workflow must be ready (`validate_project`). |
| `output_dir` | string | Folder that receives the plugin: an absolute path or one starting with `~`. Relative paths resolve against the Visage process's folder, so avoid them. Default `<project>/dist`. |

Writes `<output_dir>/<plugin>/` and `<output_dir>/<plugin>-<version>.zip`, replacing a previous export of the same plugin. A folder with that name that Visage did not create is never overwritten. Returns:
```json
{ "plugin": "blog-post", "version": "0.1.0", "path": "/.../dist/blog-post", "warnings": [], "zip": "/.../dist/blog-post-0.1.0.zip" }
```
See [exported-plugins.md](exported-plugins.md) for what the plugin contains and how to install it.

### `export_diagram`
`project_id`. Returns a Mermaid flowchart as text, which GitHub, GitLab and most Markdown viewers render:
```
flowchart LR
  n_draft["Draft"]
  n_review{"Review<br/>Ready?"}
  n_done(["Published"])
  n_draft --> n_review
  n_review -->|"approved"| n_done
  n_review -->|"changes"| n_draft
```
Steps are boxes, evaluated steps are diamonds with their question (shortened when long), final states are rounded. Arcs show their label or the result they route on (`yes`, `no`, an option, `≥ 0.8`, `otherwise`); `on_fail` routes are dashed and labelled `invalid result`. Paste it in a fenced `mermaid` block.

### `open_editor`
| Argument | Type | Notes |
| --- | --- | --- |
| `project_id` | string | Open this project directly. |
| `open` | boolean | `true` also opens the URL in the user's browser. Default `false`. |

Returns `{ "url": "http://127.0.0.1:4317/?project=blog-post", "opened": false }`. Fails when the server was started with `--no-ui` or no port was free.

## Common errors

| Message | Cause and fix |
| --- | --- |
| `Project not found: <id>` / `Node not found: <id>` | Wrong ID; call `list_projects` or `get_workflow`. |
| `Invalid identifier` | IDs use letters, digits, `-` and `_`. |
| `Invalid transition target from <node>` | An arc points to a node that does not exist; create it first. |
| `Node <id>: Unsupported transition expression: ...` | `when` must be `<path> <operator> <literal>`; see [workflow-format.md](workflow-format.md). |
| `Node <id>: Unsupported transition value: approved` | Quote text literals: `output.result == "approved"`. |
| `Node <id>: Right side of 'in' must be a list or string` | Use a list: `output.result in ["a", "b"]`. |
| `Arc to <id>: when cannot be empty; leave it out for the otherwise arc` | Remove the empty `when`. |
| `Node <id>: choice options must be unique` | Remove duplicate options. |
| `Final nodes cannot have transitions` | Final states end the run; point arcs at them instead. |
| `Add a starting node and a final state before exporting this workflow` | Export of a workflow without nodes. |
| `Workflow needs a terminal node; Skill not found for ...` | Export of an unfinished workflow: the message joins every blocking issue; fix each one. |
| `workflow.yaml is changed with the workflow tools ...` | `write_file` cannot change the workflow; use `put_workflow` or the node tools. |
| `Another Visage process is busy with this file; try again` | Another session is saving the same file; retry. |
