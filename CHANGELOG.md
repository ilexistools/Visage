# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.5.0] - 2026-10-09

### Added

- A "Reorganize layout" button next to the line styles arranges the canvas automatically: steps in ranks along the flow, without overlaps, with room for arc labels, in the orientation that fits the screen best, then fitted to view. Clicking again gives a different arrangement each time (order of branches, spacing, orientation when both fit), never with overlaps or more than one extra crossing. Undo restores the previous arrangement.

### Changed

- A step's evaluation question is shown once, above its first arc, instead of on every arc; the other arcs show it on hover.

## [0.4.0] - 2026-10-09

### Added

- Postconditions: a final state can declare `postcondition: {command, message?, timeout_seconds?}`. The exported runner runs it on arrival and reports the run as `failed` unless it exits 0, so a good score no longer completes a run whose product is broken. The result is in the reply and in `history.jsonl`, and the Inspector edits it for final states.
- `shared_references`: project files every step receives as `shared_files`, for the names, paths and interfaces steps must agree on. They are exported under `shared/`, and postconditions find them through `VISAGE_SHARED_DIR`.
- Completed runs report `final_step` and `final_output` (the last step's result and reason), not only the final state's fixed description.
- Validation warns when a `when` names an unknown step (`state.attempts.fixx`) or state key, which made the arc silently never match.
- `Workflow exceeded max_steps` lists the submissions per step.
- Authoring guide sections on a shared contract between steps and on verifying a runtime artifact with only Node.js and the shell.

### Changed

- `state.attempts` is counted by the engine (`decide`) instead of by each caller.
- The documentation states that `max_attempts` counts consecutive invalid results, that a valid result resets the count and that `on_fail` never catches a valid result.

## [0.3.1] - 2026-10-08

### Added

- Validation warns about unknown node keys, such as a misspelled field or text cut at a comma inside a YAML `{...}` mapping.

### Fixed

- The README quick start installs the frontend dependencies, without which `npm run package` failed.
- Exported Skills tell the agent to pass `--run <name>` when the user names the run.

## [0.3.0] - 2026-10-08

First tagged release. Version 0.2.0 was only used internally during the move from Python to Node.js and was never released.

### Changed

- Replaced the Python backend with a single Node.js server (`server/`) that serves the editor, the REST API and MCP (stdio and Streamable HTTP), bundled into one `visage.js` file.
- Distributed Visage itself as a Claude Code / Codex plugin with a `visage` Skill and MCP server (`npm run package`).
- Moved the project catalog from SQLite to `~/.visage/projects.json`.
- Exported workflow plugins now use a Node.js runner (`scripts/flow.mjs`) instead of Python.
- Removed harness selection and workflow execution from the editor; workflows are designed and exported, then run in Codex or Claude Code.

### Added

- Step evaluation standardised on three result types, predicate (true/false), choice (one option) and score (0 to 1), with retries with feedback, failure routes, arcs routed on the result and warnings for results without an arc. Replaces the free-form output schema and checks.
- Plugin export with an orchestrator Skill and a runner that enforces the state machine.
- Export menu with PNG images of the canvas and Mermaid flowcharts (which GitHub renders); plugin READMEs include the diagram.
- Harness documentation in `docs/harness` (installation, the `visage` Skill, MCP tool reference, workflow format, authoring guide, exported plugin protocol), shipped inside the Visage plugin and checked by tests.
- Workflow scenarios (`scenarios.yaml`, Tests panel, `test_workflow` MCP tool) simulate scripted results with the runner's rules; the conformance kit (`visage.js conformance`) runs a probe workflow through Claude Code, Codex or any CLI and audits the run. The runner's `history.jsonl` records every submission.
- Imported Skill files are listed in the Inspector and can be deleted; the Explorer can be hidden (button or Cmd/Ctrl+B).
- MCP tools to create, edit, validate and export workflows, and to open the editor.
- The editor shows the version with the build (commit hash, `-dirty` for uncommitted changes) in its tooltip; `visage.js --version` prints both.

## [0.1.0]

Initial Python version.

### Added

- Created the local visual workflow editor and Python runtime.
- Added one Skill node type with initial and final state markers and validated transitions.
- Added Codex CLI, Claude Code and generic CLI harness adapters.
- Added a SQLite project and run catalog, plus persisted state, checkpoints, execution history and artifacts.
- Added a deterministic sample project and automated backend tests.
- Made the Explorer and Inspector resizable, collapsible and dockable, and reduced the editor chrome to expand the canvas.
- Removed the canvas title strip and moved Skill creation to the topbar as an icon button.
- Removed Human Review nodes and manual review actions; the sample now routes directly from Skill output to its final state.
- Made harness selection a workflow-wide setting shared by every Skill node.
- Added illustrative text labels to workflow arcs, separate from transition decision conditions.
- Added an inline Markdown Skill editor and imports for binary or text resources into each Skill folder.

[Unreleased]: https://github.com/ilexistools/Visage/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ilexistools/Visage/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ilexistools/Visage/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ilexistools/Visage/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ilexistools/Visage/releases/tag/v0.3.0
