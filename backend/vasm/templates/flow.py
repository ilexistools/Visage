#!/usr/bin/env python3
"""Standalone runner for a Visage workflow exported as a plugin.

The agent executes each step; this script owns the state machine: it says which
step to run, evaluates the submitted output and chooses the next step.
Only the Python standard library is required.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL_DIR = HERE.parent
sys.path.insert(0, str(HERE))
import vasm_engine as engine  # noqa: E402

WORKFLOW = json.loads((SKILL_DIR / "workflow.json").read_text(encoding="utf-8"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def state_root(args: argparse.Namespace) -> Path:
    root = args.state_dir or os.environ.get("VISAGE_STATE_DIR") or Path.cwd() / ".visage" / "runs" / WORKFLOW["plugin"]
    return Path(root).resolve()


def run_path(args: argparse.Namespace, run_id: str | None = None) -> Path:
    root = state_root(args)
    run_id = run_id or getattr(args, "run", None)
    if not run_id:
        latest = root / "LATEST"
        if not latest.exists():
            fail("No run found. Start one with the 'start' command.")
        run_id = latest.read_text(encoding="utf-8").strip()
    path = root / run_id
    if not (path / "state.json").exists():
        fail(f"Run not found: {run_id}")
    return path


def load(path: Path) -> dict:
    return json.loads((path / "state.json").read_text(encoding="utf-8"))


def save(path: Path, state: dict) -> None:
    state["updated_at"] = now()
    path.mkdir(parents=True, exist_ok=True)
    temp = path / "state.json.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path / "state.json")
    with (path / "history.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"timestamp": state["updated_at"], "status": state["run_status"], "node": state["current_node"]}, ensure_ascii=False) + "\n")


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def fail(message: str) -> None:
    emit({"status": "error", "error": message})
    sys.exit(1)


def instruction(path: Path, state: dict) -> dict:
    node_id = state["current_node"]
    node = WORKFLOW["nodes"][node_id]
    if node.get("terminal") or state["run_status"] != "running":
        return summary(path, state)
    step_dir = SKILL_DIR / "nodes" / node_id
    output_file = path / "outputs" / f"{state['steps'] + 1:03d}-{node_id}.json"
    artifact_dir = path / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    contract = {}
    if node.get("output_schema"):
        contract["schema"] = node["output_schema"]
    if node.get("checks"):
        contract["checks"] = engine.normalized_checks(node)
    return {
        "status": "awaiting_output",
        "run_id": state["run_id"],
        "node": node_id,
        "label": node.get("label", node_id),
        "description": node.get("description", ""),
        "attempt": state["retries"].get(node_id, 0) + 1,
        "max_attempts": node.get("max_attempts", 1),
        "step_file": str(step_dir / "STEP.md"),
        "resources_dir": str(step_dir),
        "feedback": state["data"]["feedback"].get(node_id, []),
        "input": state["data"]["input"],
        "previous_outputs": state["data"]["outputs"],
        "output_contract": contract,
        "artifact_dir": str(artifact_dir),
        "output_file": str(output_file),
        "submit": f'python3 "{Path(__file__).resolve()}" submit --run {state["run_id"]} --state-dir "{state_root_of(path)}" --output-file "{output_file}"',
    }


def state_root_of(path: Path) -> Path:
    return path.parent


def summary(path: Path, state: dict) -> dict:
    result = {"status": state["run_status"], "run_id": state["run_id"], "node": state["current_node"], "outputs": state["data"]["outputs"], "artifact_dir": str(path / "artifacts")}
    if state.get("error"):
        result["error"] = state["error"]
    final = WORKFLOW["nodes"].get(state["current_node"], {})
    if state["run_status"] == "completed" and final.get("description"):
        result["final_state"] = final["description"]
    return result


def settle(state: dict) -> None:
    if WORKFLOW["nodes"][state["current_node"]].get("terminal"):
        state["run_status"] = "completed"


def cmd_start(args: argparse.Namespace) -> None:
    run_input = {}
    if args.input_file:
        run_input = json.loads(Path(args.input_file).read_text(encoding="utf-8"))
    elif args.input:
        try:
            run_input = json.loads(args.input)
        except json.JSONDecodeError:
            run_input = {"text": args.input}
    run_id = args.run or "run-" + uuid.uuid4().hex[:10]
    path = state_root(args) / run_id
    if (path / "state.json").exists():
        fail(f"Run already exists: {run_id}")
    state = {
        "run_id": run_id, "workflow": WORKFLOW["workflow"], "current_node": WORKFLOW["start"],
        "run_status": "running", "data": engine.new_state_data(run_input), "attempts": {}, "retries": {}, "steps": 0,
        "created_at": now(),
    }
    settle(state)
    save(path, state)
    (state_root(args) / "LATEST").write_text(run_id, encoding="utf-8")
    emit(instruction(path, state))


def cmd_next(args: argparse.Namespace) -> None:
    path = run_path(args)
    emit(instruction(path, load(path)))


def cmd_submit(args: argparse.Namespace) -> None:
    path = run_path(args)
    state = load(path)
    if state["run_status"] != "running":
        fail(f"Run is {state['run_status']}; nothing to submit.")
    if args.output_file:
        text = Path(args.output_file).read_text(encoding="utf-8")
    elif args.output:
        text = args.output
    else:
        text = sys.stdin.read()
    output = engine.parse_output(text)
    node_id = state["current_node"]
    if args.node and args.node != node_id:
        fail(f"Current step is {node_id}, not {args.node}. Run the 'next' command to see the current step.")
    state["attempts"][node_id] = state["attempts"].get(node_id, 0) + 1
    decision = engine.decide(WORKFLOW, state, node_id, output)
    outputs_dir = path / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    (outputs_dir / f"{state['steps']:03d}-{node_id}.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    if decision["status"] == "failed":
        state["run_status"] = "failed"
        state["error"] = decision["error"]
    elif decision["status"] == "next":
        state["current_node"] = decision["next_node"]
        settle(state)
    save(path, state)
    result = {"decision": decision["status"], "evaluated_node": node_id, "errors": decision["errors"]}
    if decision["status"] == "next":
        result["next_node"] = decision["next_node"]
    result.update(instruction(path, state))
    emit(result)


def cmd_status(args: argparse.Namespace) -> None:
    path = run_path(args)
    state = load(path)
    emit({**summary(path, state), "attempts": state["attempts"], "steps": state["steps"]})


def cmd_list(args: argparse.Namespace) -> None:
    root = state_root(args)
    runs = []
    for item in sorted(root.glob("*/state.json")) if root.exists() else []:
        state = json.loads(item.read_text(encoding="utf-8"))
        runs.append({"run_id": state["run_id"], "status": state["run_status"], "node": state["current_node"], "updated_at": state.get("updated_at")})
    emit({"runs": runs})


def cmd_describe(_: argparse.Namespace) -> None:
    emit(WORKFLOW)


def main() -> None:
    parser = argparse.ArgumentParser(description=f"Run the {WORKFLOW['workflow'].get('name', WORKFLOW['plugin'])} workflow")
    parser.add_argument("--state-dir", help="Directory for run state (default: ./.visage/runs/<plugin>)")
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="Start a new run and print the first step")
    start.add_argument("--input", help="Run input as JSON (or plain text)")
    start.add_argument("--input-file", help="Path to a JSON file with the run input")
    start.add_argument("--run", help="Optional run ID")
    nxt = sub.add_parser("next", help="Print the current step of a run")
    nxt.add_argument("--run")
    submit = sub.add_parser("submit", help="Submit the output of the current step")
    submit.add_argument("--run")
    submit.add_argument("--node", help="Expected current node (guards against out-of-order submissions)")
    submit.add_argument("--output-file")
    submit.add_argument("--output", help="Output JSON inline")
    status = sub.add_parser("status", help="Show run status and outputs")
    status.add_argument("--run")
    sub.add_parser("list", help="List runs")
    sub.add_parser("describe", help="Print the workflow definition")
    for child in sub.choices.values():
        child.add_argument("--state-dir", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    args = parser.parse_args()
    {"start": cmd_start, "next": cmd_next, "submit": cmd_submit, "status": cmd_status, "list": cmd_list, "describe": cmd_describe}[args.command](args)


if __name__ == "__main__":
    main()
