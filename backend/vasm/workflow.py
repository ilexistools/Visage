from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .engine import check_schema_definition, matches, next_node, normalized_checks, resolve  # noqa: F401  (re-exported)
from .store import checked_id

HARNESSES = {"generic_cli", "codex", "claude"}
REASONING_EFFORTS = {"minimal", "low", "medium", "high", "xhigh"}


def parse_workflow(source: str) -> dict[str, Any]:
    try:
        workflow = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML: {exc}") from exc
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), dict):
        raise ValueError("Workflow must contain a nodes map")
    return workflow


def validate_workflow(source: str, project_path: Path, strict: bool = False) -> tuple[dict[str, Any], list[str]]:
    """Validate a workflow document.

    Structural problems always raise. Problems that only prevent execution (no
    start node, no final node, missing Skill files) are returned as warnings so a
    workflow can be built incrementally, and raise when `strict` is true.
    """
    workflow = parse_workflow(source)
    nodes = workflow["nodes"]
    workflow.setdefault("harness", "codex")
    harness = workflow["harness"]
    if not isinstance(harness, str) or harness not in HARNESSES:
        raise ValueError("Unsupported workflow harness")
    if harness == "codex":
        workflow.setdefault("model", "gpt-6-luna")
        workflow.setdefault("reasoning_effort", "medium")
    model = workflow.get("model")
    if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 120):
        raise ValueError("Model must be a nonempty model ID")
    if workflow.get("reasoning_effort") not in (None, *REASONING_EFFORTS):
        raise ValueError(f"reasoning_effort must be one of {', '.join(sorted(REASONING_EFFORTS))}")
    max_steps = workflow.get("max_steps")
    if max_steps is not None and (not isinstance(max_steps, int) or isinstance(max_steps, bool) or not 1 <= max_steps <= 10_000):
        raise ValueError("max_steps must be an integer between 1 and 10000")
    readiness: list[str] = []
    warnings: list[str] = []
    if not nodes:
        if workflow.get("start") not in (None, ""):
            raise ValueError("An empty workflow cannot have a start node")
        if strict:
            raise ValueError("Add a starting node and a final state before exporting this workflow")
        return workflow, []
    if workflow.get("start") not in nodes:
        readiness.append("Start node must exist")
    if not any(node.get("terminal") for node in nodes.values() if isinstance(node, dict)):
        readiness.append("Workflow needs a terminal node")
    for node_id, node in nodes.items():
        checked_id(node_id)
        if not isinstance(node, dict) or node.get("type") != "skill":
            raise ValueError(f"Invalid node type: {node_id}")
        if "harness" in node:
            raise ValueError(f"Configure harness at workflow level, not on node {node_id}")
        if node.get("terminal"):
            if node.get("next"):
                raise ValueError(f"Final node {node_id} cannot have transitions")
        else:
            skill = (node.get("skill") or {}).get("path")
            if not isinstance(skill, str) or not skill.endswith("SKILL.md"):
                raise ValueError(f"Node {node_id} needs a SKILL.md path")
            skill_path = (project_path / skill).resolve()
            if not skill_path.is_relative_to(project_path.resolve()):
                raise ValueError(f"Skill path escapes the project for {node_id}: {skill}")
            if not skill_path.is_file():
                readiness.append(f"Skill not found for {node_id}: {skill}")
        _validate_evaluation(node_id, node, nodes)
        for transition in node.get("next", []) or []:
            if not isinstance(transition, dict) or transition.get("goto") not in nodes:
                raise ValueError(f"Invalid transition target from {node_id}")
            if "when" in transition:
                matches(transition["when"], {"output": {}, "state": {}})
        if not node.get("terminal") and not node.get("next"):
            warnings.append(f"Node {node_id} has no transitions")
    if readiness and strict:
        raise ValueError("; ".join(readiness))
    if workflow.get("start") in nodes:
        visited = set()
        pending = [workflow["start"]]
        while pending:
            current = pending.pop()
            if current in visited:
                continue
            visited.add(current)
            pending.extend(t["goto"] for t in nodes[current].get("next", []) or [])
            if nodes[current].get("on_fail"):
                pending.append(nodes[current]["on_fail"])
        warnings.extend(f"Node {node_id} is unreachable" for node_id in nodes if node_id not in visited)
    return workflow, readiness + warnings


def _validate_evaluation(node_id: str, node: dict[str, Any], nodes: dict[str, Any]) -> None:
    if "output_schema" in node:
        try:
            check_schema_definition(node["output_schema"])
        except ValueError as exc:
            raise ValueError(f"Node {node_id}: {exc}") from None
    try:
        for check in normalized_checks(node):
            matches(check["when"], {"output": {}, "state": {}})
    except ValueError as exc:
        raise ValueError(f"Node {node_id}: {exc}") from None
    attempts = node.get("max_attempts", 1)
    if not isinstance(attempts, int) or isinstance(attempts, bool) or not 1 <= attempts <= 20:
        raise ValueError(f"Node {node_id}: max_attempts must be an integer between 1 and 20")
    if node.get("on_fail") is not None and node["on_fail"] not in nodes:
        raise ValueError(f"Node {node_id}: on_fail must reference an existing node")
