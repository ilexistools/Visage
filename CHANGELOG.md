# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- Replaced the Python backend with a single Node.js server (`server/`) that serves the editor, the REST API and MCP (stdio and Streamable HTTP), bundled into one `visage.js` file.
- Distributed Visage itself as a Claude Code / Codex plugin with a `visage` Skill and MCP server (`npm run package`).
- Moved the project catalog from SQLite to `~/.visage/projects.json`.
- Exported workflow plugins now use a Node.js runner (`scripts/flow.mjs`) instead of Python.
- Removed harness selection and workflow execution from the editor; workflows are designed and exported, then run in Codex or Claude Code.

### Added

- Step evaluation standardised on three result types, predicate (true/false), choice (one option) and score (0 to 1), with retries with feedback, failure routes, arcs routed on the result and warnings for results without an arc. Replaces the free-form output schema and checks.
- Plugin export with an orchestrator Skill and a runner that enforces the state machine.
- Export menu with PNG images of the canvas and Mermaid state diagrams; plugin READMEs include the diagram.
- Harness documentation in `docs/harness` (installation, the `visage` Skill, MCP tool reference, workflow format, authoring guide, exported plugin protocol), shipped inside the Visage plugin and checked by tests.
- Imported Skill files are listed in the Inspector and can be deleted; the Explorer can be hidden (button or Cmd/Ctrl+B).
- MCP tools to create, edit, validate and export workflows, and to open the editor.

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
