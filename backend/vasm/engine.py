"""State machine core shared by the Visage runtime and exported plugins.

This module must only use the Python standard library: the plugin exporter
copies it verbatim next to the standalone runner script.
"""
from __future__ import annotations

import ast
import json
import re
from typing import Any

PATH = r"(?:output|state)(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*"
EXPRESSION = re.compile(rf"^\s*({PATH})\s*(==|!=|>=|<=|>|<|not in|in)\s*(.+?)\s*$")
LITERALS = {"true": True, "false": False, "null": None}
DEFAULT_MAX_STEPS = 50


def resolve(data: Any, path: str) -> Any:
    value = data
    for part in path.split("."):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif part == "length" and isinstance(value, (list, str, dict)):
            value = len(value)
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def _literal(raw: str) -> Any:
    if raw in LITERALS:
        return LITERALS[raw]
    try:
        return ast.literal_eval(raw)
    except (SyntaxError, ValueError):
        raise ValueError(f"Unsupported transition value: {raw}") from None


def matches(expression: str, context: dict[str, Any]) -> bool:
    """Evaluate a restricted `path operator literal` expression; never executes code."""
    match = EXPRESSION.fullmatch(expression)
    if not match:
        raise ValueError(f"Unsupported transition expression: {expression}")
    left, operator, raw_right = match.groups()
    right = _literal(raw_right)
    value = resolve(context, left)
    if operator == "==":
        return value == right
    if operator == "!=":
        return value != right
    if operator in {"in", "not in"}:
        if not isinstance(right, (list, tuple, str)):
            raise ValueError(f"Right side of '{operator}' must be a list or string")
        try:
            found = value in right
        except TypeError:
            found = False
        return found if operator == "in" else not found
    numeric = (int, float)
    if value is None or isinstance(value, bool) or isinstance(right, bool):
        return False
    if not ((isinstance(value, numeric) and isinstance(right, numeric)) or (isinstance(value, str) and isinstance(right, str))):
        return False
    return {">": value > right, "<": value < right, ">=": value >= right, "<=": value <= right}[operator]


def next_node(node: dict[str, Any], context: dict[str, Any]) -> str | None:
    for transition in node.get("next", []):
        if "when" not in transition or matches(transition["when"], context):
            return transition["goto"]
    return None


# --- Output contracts -------------------------------------------------------

TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def validate_schema(value: Any, schema: dict[str, Any], path: str = "output") -> list[str]:
    """Validate the commonly used subset of JSON Schema and return readable errors."""
    errors: list[str] = []
    expected = schema.get("type")
    if expected is not None:
        options = expected if isinstance(expected, list) else [expected]
        if not any(TYPES.get(option, lambda _: False)(value) for option in options):
            return [f"{path} must be of type {' or '.join(options)}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path} must be one of {json.dumps(schema['enum'], ensure_ascii=False)}")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path} must equal {json.dumps(schema['const'], ensure_ascii=False)}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key} is required")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                errors.extend(validate_schema(item, properties[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key} is not allowed")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path} must have at least {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path} must have at most {schema['maxItems']} items")
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                errors.extend(validate_schema(item, schema["items"], f"{path}[{index}]"))
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path} must have at least {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path} must have at most {schema['maxLength']} characters")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path} must match {schema['pattern']}")
    if TYPES["number"](value):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path} must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path} must be <= {schema['maximum']}")
    return errors


def check_schema_definition(schema: Any) -> None:
    if not isinstance(schema, dict):
        raise ValueError("output_schema must be a JSON Schema object")
    expected = schema.get("type")
    for option in expected if isinstance(expected, list) else [expected] if expected else []:
        if option not in TYPES:
            raise ValueError(f"Unsupported schema type: {option}")
    for child in schema.get("properties", {}).values():
        check_schema_definition(child)
    if isinstance(schema.get("items"), dict):
        check_schema_definition(schema["items"])


def normalized_checks(node: dict[str, Any]) -> list[dict[str, str]]:
    checks = []
    for check in node.get("checks", []) or []:
        if isinstance(check, str):
            check = {"when": check}
        if not isinstance(check, dict) or not isinstance(check.get("when"), str):
            raise ValueError("Each check needs a 'when' expression")
        checks.append({"when": check["when"], "message": check.get("message") or f"Check failed: {check['when']}"})
    return checks


def evaluate(node: dict[str, Any], output: dict[str, Any], context: dict[str, Any]) -> list[str]:
    """Return the evaluation errors for a node output; an empty list means it passed."""
    errors = []
    if isinstance(node.get("output_schema"), dict):
        errors.extend(validate_schema(output, node["output_schema"]))
    for check in normalized_checks(node):
        if not matches(check["when"], context):
            errors.append(check["message"])
    return errors


def parse_output(text: str) -> dict[str, Any]:
    """Parse harness output as JSON, accepting fenced or embedded objects."""
    text = text.strip()
    candidates = [text]
    candidates.extend(reversed(re.findall(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)))
    if "{" in text and "}" in text:
        candidates.append(text[text.index("{"): text.rindex("}") + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return value if isinstance(value, dict) else {"value": value}
    return {"text": text}


# --- Transitions ------------------------------------------------------------

def new_state_data(run_input: Any = None) -> dict[str, Any]:
    return {"input": run_input if run_input is not None else {}, "outputs": {}, "feedback": {}, "last_output": None}


def context_for(state: dict[str, Any], output: Any = None) -> dict[str, Any]:
    return {"output": output if output is not None else {}, "state": {**state["data"], "attempts": state.get("attempts", {})}}


def decide(workflow: dict[str, Any], state: dict[str, Any], node_id: str, output: dict[str, Any]) -> dict[str, Any]:
    """Evaluate a node output and choose the next state.

    Mutates `state` (outputs, feedback, retries, steps) and returns a decision with
    `status` set to `next`, `retry` or `failed`.
    """
    decision = _decide(workflow, state, node_id, output)
    limit = int(workflow.get("max_steps", DEFAULT_MAX_STEPS))
    target = workflow["nodes"].get(decision.get("next_node") or node_id, {})
    if decision["status"] != "failed" and state["steps"] >= limit and not target.get("terminal"):
        return {"status": "failed", "node": node_id, "errors": decision["errors"], "error": f"Workflow exceeded max_steps ({limit})"}
    return decision


def _decide(workflow: dict[str, Any], state: dict[str, Any], node_id: str, output: dict[str, Any]) -> dict[str, Any]:
    node = workflow["nodes"][node_id]
    data = state["data"]
    data.setdefault("outputs", {})
    data.setdefault("feedback", {})
    retries = state.setdefault("retries", {})
    state["steps"] = state.get("steps", 0) + 1
    data["outputs"][node_id] = output
    data["last_output"] = output
    context = context_for(state, output)
    errors = evaluate(node, output, context)
    if errors:
        retries[node_id] = retries.get(node_id, 0) + 1
        data["feedback"][node_id] = errors
        if retries[node_id] < int(node.get("max_attempts", 1)):
            return {"status": "retry", "node": node_id, "errors": errors}
        retries[node_id] = 0
        if node.get("on_fail"):
            return {"status": "next", "node": node_id, "next_node": node["on_fail"], "errors": errors, "evaluation": "failed"}
        return {"status": "failed", "node": node_id, "errors": errors, "error": f"Output of {node_id} failed evaluation: {'; '.join(errors)}"}
    retries[node_id] = 0
    data["feedback"].pop(node_id, None)
    target = next_node(node, context)
    if target is None:
        return {"status": "failed", "node": node_id, "errors": [], "error": f"No transition matched for node {node_id}"}
    return {"status": "next", "node": node_id, "next_node": target, "errors": [], "evaluation": "passed"}


def contract_text(node: dict[str, Any]) -> str:
    """Describe the output contract of a node for inclusion in agent instructions."""
    parts = []
    if node.get("output_schema"):
        parts.append("The JSON object must satisfy this JSON Schema:\n" + json.dumps(node["output_schema"], ensure_ascii=False, indent=2))
    checks = normalized_checks(node)
    if checks:
        parts.append("It must also pass these checks:\n" + "\n".join(f"- `{check['when']}` ({check['message']})" for check in checks))
    return "\n\n".join(parts)
