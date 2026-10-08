"""MCP server that gives any agent harness full control over Visage projects.

Run with `uv run --directory backend python -m vasm.mcp_server` (stdio). It shares the data
directory with the HTTP API, so changes appear in the visual editor.
"""
from __future__ import annotations

import functools
from typing import Any

import yaml
from fastapi import HTTPException
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import __version__, api, database, exporter, runtime
from .store import checked_id, project_dir, read_json, run_dir, workflow_path

INSTRUCTIONS = """Visage builds workflows where each node is an agent Skill and transitions form a state machine.

Workflow model (stored as workflow.yaml in the project folder):
- Root: harness (codex | claude | generic_cli), model, reasoning_effort, start (node ID), max_steps, nodes.
- Node: type: skill, label, description, skill.path (skills/<node>/SKILL.md), terminal (true for final states, which run nothing),
  next: ordered list of {goto, when?, label?}; the first transition whose `when` matches is taken.
- Evaluation gate per node: output_schema (JSON Schema subset), checks (list of {when, message}),
  max_attempts (retries the node with feedback when evaluation fails), on_fail (node to route to after the last failed attempt).
- Expressions: `<path> <op> <literal>` where path starts with output. or state. and op is ==, !=, <, <=, >, >=, in, not in.
  state has input, outputs.<node>, feedback.<node>, attempts.<node>; `.length` gives a list/string length.

Typical flow: create_project → upsert_node (with skill_markdown) for each step → set_transitions → set_start → upsert_node(terminal=True)
→ validate_project → create_run/start_run (executes through the configured harness) or export_plugin (portable Claude Code / Codex plugin)."""

mcp = MCPServer("visage", version=__version__, instructions=INSTRUCTIONS)


def tool(func):
    """Register a tool and turn API errors into MCP tool errors."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except HTTPException as exc:
            raise ToolError(str(exc.detail)) from None
        except (ValueError, FileNotFoundError, KeyError) as exc:
            raise ToolError(f"{type(exc).__name__}: {exc}") from None
    return mcp.tool()(wrapper)


def _load(project_id: str) -> dict[str, Any]:
    return yaml.safe_load(workflow_path(project_id).read_text(encoding="utf-8"))


def _save(project_id: str, workflow: dict[str, Any]) -> dict[str, Any]:
    return api.put_workflow(project_id, api.WorkflowSource(source=yaml.safe_dump(workflow, sort_keys=False, allow_unicode=True)))


def _node(workflow: dict[str, Any], node_id: str) -> dict[str, Any]:
    if node_id not in workflow["nodes"]:
        raise ValueError(f"Node not found: {node_id}")
    return workflow["nodes"][node_id]


# --- Projects ---------------------------------------------------------------

@tool
def list_projects() -> list[dict[str, Any]]:
    """List Visage projects with their folders."""
    return database.list_projects()


@tool
def create_project(project_id: str, name: str, parent_path: str | None = None) -> dict[str, Any]:
    """Create a project with an empty workflow. project_id: letters, digits, - and _. parent_path: optional existing folder."""
    return api.create_project(api.CreateProject(id=project_id, name=name, parent_path=parent_path))


@tool
def delete_project(project_id: str, confirm: bool = False) -> dict[str, Any]:
    """Permanently delete a project folder, its Skills and runs. Requires confirm=true."""
    if not confirm:
        raise ValueError("Pass confirm=true to delete the project and all its files")
    return api.delete_project(project_id)


# --- Workflow ---------------------------------------------------------------

@tool
def get_workflow(project_id: str) -> dict[str, Any]:
    """Return the workflow YAML source, the parsed workflow and validation warnings."""
    return api.get_workflow(project_id)


@tool
def put_workflow(project_id: str, source: str) -> dict[str, Any]:
    """Replace the whole workflow with YAML source. Structural errors are rejected; readiness issues come back as warnings."""
    return api.put_workflow(project_id, api.WorkflowSource(source=source))


@tool
def configure_workflow(project_id: str, name: str | None = None, description: str | None = None, version: str | None = None,
                       harness: str | None = None, model: str | None = None, reasoning_effort: str | None = None,
                       max_steps: int | None = None) -> dict[str, Any]:
    """Change workflow-level settings: display name, description, version, harness (codex|claude|generic_cli), model, reasoning_effort, max_steps."""
    workflow = _load(project_id)
    meta = workflow.setdefault("workflow", {})
    for key, value in {"name": name, "description": description, "version": version}.items():
        if value is not None:
            meta[key] = value
    for key, value in {"harness": harness, "model": model, "reasoning_effort": reasoning_effort, "max_steps": max_steps}.items():
        if value is not None:
            workflow[key] = value
    return _save(project_id, workflow)


@tool
def upsert_node(project_id: str, node_id: str, label: str | None = None, description: str | None = None,
                skill_markdown: str | None = None, skill_path: str | None = None, terminal: bool | None = None,
                output_schema: dict[str, Any] | None = None, checks: list[dict[str, str]] | None = None,
                max_attempts: int | None = None, on_fail: str | None = None, command: list[str] | None = None,
                position: dict[str, float] | None = None) -> dict[str, Any]:
    """Create or update a Skill node. Only given fields change.

    skill_markdown writes the node's SKILL.md (default path skills/<node_id>/SKILL.md).
    output_schema/checks/max_attempts/on_fail define the evaluation gate; pass an empty dict/list or on_fail="" to clear.
    command is only used by the generic_cli harness. The first node created becomes the start node.
    """
    checked_id(node_id)
    workflow = _load(project_id)
    nodes = workflow.setdefault("nodes", {})
    created = node_id not in nodes
    node = nodes.setdefault(node_id, {"type": "skill", "label": label or node_id, "next": []})
    if created and not terminal:
        node["skill"] = {"path": skill_path or f"skills/{node_id}/SKILL.md"}
        node["position"] = position or {"x": 160 + 260 * (len(nodes) - 1), "y": 180}
    for key, value in {"label": label, "description": description, "position": position, "command": command, "max_attempts": max_attempts}.items():
        if value is not None:
            node[key] = value
    for key, value in {"output_schema": output_schema, "checks": checks, "on_fail": on_fail}.items():
        if value is not None:
            if value in ({}, [], ""):
                node.pop(key, None)
            else:
                node[key] = value
    if skill_path is not None:
        node["skill"] = {"path": skill_path}
    if terminal is not None:
        if terminal:
            node["terminal"] = True
            node.pop("next", None)
        else:
            node.pop("terminal", None)
            node.setdefault("next", [])
            node.setdefault("skill", {"path": f"skills/{node_id}/SKILL.md"})
    if skill_markdown is not None:
        path = node.get("skill", {}).get("path")
        if not path:
            raise ValueError("Final nodes have no Skill; set terminal=false first")
        api.put_project_file(project_id, path, api.ProjectFileContent(content=skill_markdown))
    if not workflow.get("start"):
        workflow["start"] = node_id
    return {"node_id": node_id, "created": created, **_save(project_id, workflow)}


@tool
def remove_node(project_id: str, node_id: str) -> dict[str, Any]:
    """Remove a node and every transition or on_fail route pointing to it. The Skill file is kept."""
    workflow = _load(project_id)
    _node(workflow, node_id)
    del workflow["nodes"][node_id]
    for node in workflow["nodes"].values():
        if "next" in node:
            node["next"] = [t for t in node["next"] if t.get("goto") != node_id]
        if node.get("on_fail") == node_id:
            node.pop("on_fail")
    if workflow.get("start") == node_id:
        workflow["start"] = next(iter(workflow["nodes"]), "")
    return _save(project_id, workflow)


@tool
def set_transitions(project_id: str, node_id: str, transitions: list[dict[str, str]]) -> dict[str, Any]:
    """Replace the outgoing transitions of a node. Each item: {goto, when?, label?}. Order matters: the first matching `when` wins; omit `when` for the default."""
    workflow = _load(project_id)
    node = _node(workflow, node_id)
    if node.get("terminal"):
        raise ValueError("Final nodes cannot have transitions")
    node["next"] = [{key: value for key, value in t.items() if key in {"goto", "when", "label"} and value not in (None, "")} for t in transitions]
    return _save(project_id, workflow)


@tool
def set_start(project_id: str, node_id: str) -> dict[str, Any]:
    """Make a node the initial state."""
    workflow = _load(project_id)
    _node(workflow, node_id)
    workflow["start"] = node_id
    return _save(project_id, workflow)


@tool
def validate_project(project_id: str) -> dict[str, Any]:
    """Check whether the workflow is ready to run or export; returns errors and warnings."""
    return api.validate_project(project_id)


# --- Files ------------------------------------------------------------------

@tool
def list_files(project_id: str) -> list[str]:
    """List files in the project folder."""
    return api.project_files(project_id)


@tool
def read_file(project_id: str, path: str) -> str:
    """Read a text file from the project (Skills, references, workflow.yaml)."""
    return api.project_file(project_id, path).body.decode("utf-8")


@tool
def write_file(project_id: str, path: str, content: str, encoding: str = "utf-8") -> dict[str, Any]:
    """Write a project file, e.g. a Skill or a reference. encoding: utf-8 or base64."""
    return api.put_project_file(project_id, path, api.ProjectFileContent(content=content, encoding=encoding))


# --- Runs -------------------------------------------------------------------

@tool
def create_run(project_id: str, input: Any = None) -> dict[str, Any]:
    """Create a run (not started). `input` becomes state.input for every step."""
    return api.new_run(project_id, api.RunRequest(input=input))


@tool
def start_run(run_id: str, single_step: bool = False) -> dict[str, Any]:
    """Start or resume a run in the background through the workflow harness. single_step=true pauses after one node."""
    return runtime.launch(run_id, single_step=single_step)


@tool
def pause_run(run_id: str) -> dict[str, Any]:
    """Ask a running workflow to pause after the current node."""
    return runtime.pause(run_id)


@tool
def get_run(run_id: str, history_limit: int = 30) -> dict[str, Any]:
    """Return run state, the last history events and artifacts."""
    result = api.get_run(run_id)
    result["history"] = result["history"][-history_limit:]
    return result


@tool
def list_runs(project_id: str) -> list[dict[str, Any]]:
    """List runs of a project, newest first."""
    return [run for run in api.project_runs(project_id) if run]


@tool
def read_artifact(run_id: str, path: str) -> str:
    """Read a text artifact produced by a run."""
    target = (run_dir(run_id) / "artifacts" / path).resolve()
    manifest = read_json(run_dir(run_id) / "artifacts.json", [])
    if not target.is_relative_to((run_dir(run_id) / "artifacts").resolve()) or not any(item["path"] == path for item in manifest):
        raise FileNotFoundError(path)
    return target.read_text(encoding="utf-8")


# --- Export -----------------------------------------------------------------

@tool
def export_plugin(project_id: str, output_dir: str | None = None) -> dict[str, Any]:
    """Export the workflow as a plugin for Claude Code and Codex (folder + zip). Default location: <project>/dist."""
    if not project_dir(project_id).exists():
        raise FileNotFoundError(project_id)
    return exporter.export_plugin(project_id, output_dir)


def main() -> None:
    database.bootstrap()
    runtime.recover_interrupted_runs()
    mcp.run("stdio")


if __name__ == "__main__":
    main()
