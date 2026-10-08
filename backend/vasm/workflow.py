from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

import yaml

from .store import checked_id

EXPRESSION = re.compile(r"^\s*((?:output|state)(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$")


def resolve(data: dict[str, Any], path: str) -> Any:
    value: Any = data
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def matches(expression: str, context: dict[str, Any]) -> bool:
    match = EXPRESSION.fullmatch(expression)
    if not match:
        raise ValueError(f"Unsupported transition expression: {expression}")
    left, operator, raw_right = match.groups()
    try:
        right = ast.literal_eval(raw_right)
    except (SyntaxError, ValueError):
        if raw_right == "true":
            right = True
        elif raw_right == "false":
            right = False
        elif raw_right == "null":
            right = None
        else:
            raise ValueError(f"Unsupported transition value: {raw_right}") from None
    value = resolve(context, left)
    if operator == "==":
        return value == right
    if operator == "!=":
        return value != right
    if value is None or type(value) is not type(right) or not isinstance(value, (int, float, str)):
        return False
    return {">": lambda: value > right, "<": lambda: value < right, ">=": lambda: value >= right, "<=": lambda: value <= right}[operator]()


def next_node(node: dict[str, Any], context: dict[str, Any]) -> str | None:
    for transition in node.get("next", []):
        if "when" not in transition or matches(transition["when"], context):
            return transition["goto"]
    return None


def validate_workflow(source: str, project_path: Path) -> tuple[dict[str, Any], list[str]]:
    try:
        workflow = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML: {exc}") from exc
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), dict):
        raise ValueError("Workflow must contain a nodes map")
    nodes = workflow["nodes"]
    harness = workflow.get("harness", "generic_cli")
    if not isinstance(harness, str) or harness not in {"generic_cli", "codex", "claude"}:
        raise ValueError("Unsupported workflow harness")
    if not nodes:
        if workflow.get("start") not in (None, ""):
            raise ValueError("An empty workflow cannot have a start node")
        return workflow, []
    if workflow.get("start") not in nodes:
        raise ValueError("Start node must exist")
    if not any(node.get("terminal") for node in nodes.values() if isinstance(node, dict)):
        raise ValueError("Workflow needs a terminal node")
    warnings: list[str] = []
    for node_id, node in nodes.items():
        checked_id(node_id)
        if not isinstance(node, dict) or node.get("type") != "skill":
            raise ValueError(f"Invalid node type: {node_id}")
        if "harness" in node:
            raise ValueError(f"Configure harness at workflow level, not on node {node_id}")
        node_type = node["type"]
        if not node.get("terminal"):
            skill = node.get("skill", {}).get("path")
            if not isinstance(skill, str) or not skill.endswith("SKILL.md"):
                raise ValueError(f"Node {node_id} needs a SKILL.md path")
            skill_path = (project_path / skill).resolve()
            if not skill_path.is_relative_to(project_path.resolve()) or not skill_path.is_file():
                raise ValueError(f"Skill not found for {node_id}: {skill}")
        if node.get("terminal") and node.get("next"):
            raise ValueError(f"Final node {node_id} cannot have transitions")
        for transition in node.get("next", []):
            if not isinstance(transition, dict) or transition.get("goto") not in nodes:
                raise ValueError(f"Invalid transition target from {node_id}")
            if "when" in transition:
                matches(transition["when"], {"output": {}, "state": {}})
        if not node.get("terminal") and not node.get("next"):
            warnings.append(f"Node {node_id} has no transitions")
    visited = set()
    pending = [workflow["start"]]
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        pending.extend(t["goto"] for t in nodes[current].get("next", []))
    warnings.extend(f"Node {node_id} is unreachable" for node_id in nodes if node_id not in visited)
    return workflow, warnings
