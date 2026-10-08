# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
