---
name: visage
description: "Design, edit, validate and export state-machine workflows of agent Skills with Visage. Each step is a Skill, its result (yes/no, one option, or a 0-1 score) decides the next step, and the finished workflow is exported as a Claude Code / Codex plugin. Use when the user wants to create or change a multi-step Skill workflow, turn a process into an ordered set of Skills, open the Visage visual editor, export a workflow as a plugin, or produce a diagram of one."
---
# Visage

Visage keeps workflows as **projects**: a folder with `workflow.yaml` (the state machine) and one `skills/<step>/SKILL.md` per step. You work on them through the `visage` MCP tools; the user sees the same project live in the visual editor. Visage does not run workflows itself: it exports them as plugins that Claude Code or Codex run.

## Before you start

- Call `list_projects` to see whether the workflow already exists. Reuse it rather than creating a duplicate.
- Tools that act on a project take `project_id`. Tool errors come back as text explaining what to fix; read them and retry with corrected arguments.
- Changes are saved immediately. There is no undo, so read the current state with `get_workflow` before restructuring an existing project.

## Building a workflow

1. **Plan the steps** with the user: what each step does, what it decides, and where each decision leads. Keep one clear responsibility per step. See [authoring-guide.md](references/authoring-guide.md) for patterns.
2. `create_project` with a short `project_id` (letters, digits, `-`, `_`) and a readable `name`. Then `configure_workflow` with a `description` that says when the workflow should be used: it becomes the description of the exported Skill.
3. For each step, `upsert_node` with `label`, a one-line `description` and `skill_markdown`: the complete instructions an agent will follow for that step (inputs it reads, files it writes, how it decides). When several steps depend on the same names (files in the artifact folder, test hooks, data formats), first write them to one contract file with `write_file` and list it in `configure_workflow` `shared_references`; see [authoring-guide.md](references/authoring-guide.md#shared-contract). The first step created (never a final state) becomes the start node; change it with `set_start`.
4. Give an `evaluation` to every step whose outcome chooses the next step:
   - `predicate`: result `true`/`false` ("Does the game pass every test?")
   - `choice`: result is one of `options` ("approved / changes / rejected?")
   - `score`: result is a number from 0 to 1 ("How complete is the result?")

   Always write the `question`. Steps that only produce files need no evaluation. Use `max_attempts` (consecutive invalid results allowed, each retry with feedback; the default 1 means no retry; a valid result resets the count) and `on_fail` (where to go after the last invalid try) when a step may answer badly. A valid but unwanted result never reaches `on_fail`: route it with an arc.
5. Create the end states with `upsert_node` and `terminal: true`, with a `description` of the outcome. When the workflow delivers something that can be run (a page, a game, a CLI), give the success state a `postcondition` that runs it through its real entry point using only Node.js and the shell; see [workflow-format.md](references/workflow-format.md#postconditions).
6. Connect the steps with `set_transitions` (it replaces all arcs of a step). Route on the result:
   - predicate: `output.result == true`, `output.result == false`
   - choice: `output.result == "approved"`
   - score: `output.result >= 0.8` (also `>`, `<`, `<=`)

   Order matters: the first arc whose `when` matches is taken. Leave `when` out of the last arc to make it the "otherwise" arc.
7. `validate_project`. `ready: false` lists errors that block export. Warnings such as `no arc for result false` mean the exported workflow would fail on that result: fix them unless the user explicitly accepts them.
8. Write `scenarios.yaml` (one scenario per result of each evaluated step, each loop exit and each `on_fail` route) and run `test_workflow` until every scenario passes. See [testing.md](references/testing.md).
9. `export_plugin` and give the user the plugin folder and zip paths, with how to install it (see [exported-plugins.md](references/exported-plugins.md)).

## Other tasks

- **Show the workflow**: `open_editor` with `project_id` and `open: true` opens the visual editor; give the user the returned URL either way. `export_diagram` returns a Mermaid diagram you can paste in a README or reply.
- **Edit an existing workflow**: `get_workflow`, then targeted `upsert_node` / `set_transitions` / `remove_node`. Use `put_workflow` (whole YAML) only for large rewrites, starting from the `source` that `get_workflow` returned.
- **Reference files** for a step go next to its Skill (`skills/<step>/...`) with `write_file`; mention them in the step's Skill so the agent reads them. `delete_file` removes them.
- **Deleting a project** (`delete_project` with `confirm: true`) removes its folder permanently. Do it only when the user asks.

## Rules

- Do not invent tool parameters; the full list with examples is in [mcp-tools.md](references/mcp-tools.md).
- `workflow.yaml` and `project.json` cannot be written with `write_file`; use the workflow tools, which validate every change.
- Keep step instructions self-contained: an exported step only sees its own Skill, the run input, the outputs of earlier steps and its reference files.
- The complete `workflow.yaml` format, validation errors and warnings are in [workflow-format.md](references/workflow-format.md).
