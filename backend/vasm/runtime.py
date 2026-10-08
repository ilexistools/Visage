from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from . import database
from . import store
from .store import append_jsonl, load_workflow, now, project_dir, read_json, run_dir, write_json
from .engine import contract_text, decide, new_state_data, parse_output
from .workflow import validate_workflow

LOCK = threading.RLock()
WORKERS: dict[str, threading.Thread] = {}


def event(run_id: str, kind: str, **details: Any) -> None:
    append_jsonl(run_dir(run_id) / "history.jsonl", {"timestamp": now(), "run_id": run_id, "type": kind, **details})


def state_for(run_id: str) -> dict[str, Any]:
    state = read_json(run_dir(run_id) / "state.json")
    if state is None:
        raise FileNotFoundError(run_id)
    return state


def save(run_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = now()
    write_json(run_dir(run_id, state["project_id"]) / "state.json", state)
    database.save_run(state)


def create_run(project_id: str, run_input: Any = None) -> dict[str, Any]:
    workflow, _ = validate_workflow(store.workflow_path(project_id).read_text(encoding="utf-8"), project_dir(project_id), strict=True)
    run_id = "run-" + uuid.uuid4().hex[:12]
    state = {
        "run_id": run_id, "project_id": project_id,
        "workflow": workflow.get("workflow", {}), "current_node": workflow["start"],
        "run_status": "created", "node_states": {key: "idle" for key in workflow["nodes"]},
        "data": new_state_data(run_input), "last_output": None, "attempts": {}, "retries": {}, "steps": 0, "pause_requested": False,
        "created_at": now(), "updated_at": now(),
    }
    save(run_id, state)
    write_json(run_dir(run_id) / "manifest.json", {"run_id": run_id, "project_id": project_id, "workflow": workflow})
    event(run_id, "run_created")
    return state


def recover_interrupted_runs() -> None:
    directories = [store.DATA_DIR / "runs"]
    directories.extend(store.project_dir(project["id"]) / "runs" for project in database.list_projects())
    for directory in directories:
        if not directory.exists():
            continue
        for path in directory.iterdir():
            state = read_json(path / "state.json")
            if not state or state.get("run_status") != "running" or _owned_by_live_process(state):
                continue
            state["run_status"] = "paused"
            state["pause_requested"] = False
            current = state.get("current_node")
            if current and state["node_states"].get(current) == "running":
                state["node_states"][current] = "idle"
            save(path.name, state)
            event(path.name, "run_recovered", node=current)


def _owned_by_live_process(state: dict[str, Any]) -> bool:
    """A run started by another live process (API server or MCP server) is not interrupted."""
    pid = state.get("worker_pid")
    if not isinstance(pid, int) or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def launch(run_id: str, single_step: bool = False) -> dict[str, Any]:
    with LOCK:
        state = state_for(run_id)
        if state["run_status"] not in {"created", "paused"}:
            raise ValueError(f"Cannot start run in {state['run_status']} state")
        if run_id in WORKERS and WORKERS[run_id].is_alive():
            raise ValueError("Run is already executing")
        state["run_status"] = "running"
        state["pause_requested"] = False
        state["worker_pid"] = os.getpid()
        state.pop("error", None)
        save(run_id, state)
        worker = threading.Thread(target=_execute, args=(run_id, single_step), daemon=True)
        WORKERS[run_id] = worker
        worker.start()
        return state


def pause(run_id: str) -> dict[str, Any]:
    with LOCK:
        state = state_for(run_id)
        if state["run_status"] != "running":
            raise ValueError("Only a running workflow can be paused")
        state["pause_requested"] = True
        save(run_id, state)
        return state


def _checkpoint(run_id: str, node_id: str, state: dict[str, Any]) -> None:
    checkpoint = {"timestamp": now(), "node": node_id, "state": state}
    path = run_dir(run_id) / "checkpoints" / f"{len(list((run_dir(run_id) / 'checkpoints').glob('*.json'))):04d}.json"
    write_json(path, checkpoint)


def build_prompt(skill_text: str, node_id: str, node: dict[str, Any], context: dict[str, Any]) -> str:
    sections = [
        "You are executing one step of a state-machine workflow. Perform only this step, following the Skill below.",
        f"## Skill\n\n{skill_text}",
        f"## Execution context\n\n```json\n{json.dumps(context, ensure_ascii=False, indent=2)}\n```",
    ]
    feedback = context["state"].get("feedback", {}).get(node_id)
    if feedback:
        sections.append("## Previous attempt rejected\n\nYour previous output for this step failed evaluation. Fix these issues:\n" + "\n".join(f"- {item}" for item in feedback))
    contract = contract_text(node)
    sections.append("## Output\n\nFinish with a single JSON object as your final answer (no prose after it)." + (f"\n\n{contract}" if contract else ""))
    return "\n\n".join(sections)


def _run_harness(run_id: str, state: dict[str, Any], node_id: str, node: dict[str, Any], harness: str, model: str | None = None, reasoning_effort: str = "medium") -> dict[str, Any]:
    project = project_dir(state["project_id"])
    skill_path = project / node["skill"]["path"]
    artifact_dir = run_dir(run_id) / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    context = {
        "run_id": run_id, "node_id": node_id, "state": state["data"],
        "last_output": state["last_output"], "artifact_dir": str(artifact_dir),
    }
    prompt = build_prompt(skill_path.read_text(encoding="utf-8"), node_id, node, context)
    if harness == "codex":
        command = ["codex", "exec", "--skip-git-repo-check"]
        if model:
            command.extend(["--model", model])
        command.extend(["-c", f'model_reasoning_effort="{reasoning_effort}"'])
        command.extend(["--output-last-message", str(run_dir(run_id) / "nodes" / f"{node_id}-last.txt"), "-"])
    elif harness == "claude":
        command = ["claude", "--print", "--output-format", "text", "-"]
    else:
        command = node["command"]
        if not command or not all(isinstance(item, str) for item in command):
            raise ValueError("Command must be a nonempty string list")
    (run_dir(run_id) / "nodes").mkdir(exist_ok=True)
    env = os.environ.copy()
    env.update({"VASM_RUN_ID": run_id, "VASM_NODE_ID": node_id, "VASM_ARTIFACT_DIR": str(artifact_dir), "VASM_CONTEXT_JSON": json.dumps(context)})
    result = subprocess.run(command, input=prompt, text=True, cwd=project, env=env, capture_output=True, timeout=int(node.get("timeout_seconds", 600)))
    node_dir = run_dir(run_id) / "nodes" / f"{node_id}-{state['attempts'].get(node_id, 0)}"
    node_dir.mkdir(parents=True, exist_ok=True)
    (node_dir / "stdout.txt").write_text(result.stdout, encoding="utf-8")
    (node_dir / "stderr.txt").write_text(result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Harness exited with code {result.returncode}: {result.stderr[-500:]}")
    output_text = result.stdout.strip()
    last_message = run_dir(run_id) / "nodes" / f"{node_id}-last.txt"
    if harness == "codex" and last_message.exists():
        output_text = last_message.read_text(encoding="utf-8").strip()
    output = parse_output(output_text)
    write_json(node_dir / "output.json", output)
    return output


def _collect_artifacts(run_id: str, state: dict[str, Any], node_id: str) -> None:
    directory = run_dir(run_id) / "artifacts"
    manifest_path = run_dir(run_id) / "artifacts.json"
    manifest = read_json(manifest_path, [])
    known = {item["path"] for item in manifest}
    for path in directory.rglob("*") if directory.exists() else []:
        if not path.is_file():
            continue
        relative = str(path.relative_to(directory))
        if relative in known:
            continue
        item = {"id": uuid.uuid4().hex[:12], "path": relative, "producer": node_id, "created_at": now(), "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest.append(item)
        event(run_id, "artifact_created", node=node_id, artifact=item)
    write_json(manifest_path, manifest)


def _execute(run_id: str, single_step: bool) -> None:
    completed = 0
    try:
        workflow = read_json(run_dir(run_id) / "manifest.json")["workflow"]
        event(run_id, "run_started")
        while True:
            with LOCK:
                state = state_for(run_id)
                if state["pause_requested"] or (single_step and completed):
                    state["run_status"] = "paused"
                    state["pause_requested"] = False
                    save(run_id, state)
                    event(run_id, "run_paused")
                    return
                node_id = state["current_node"]
                node = workflow["nodes"][node_id]
                if node.get("terminal"):
                    state["run_status"] = "completed"
                    state["node_states"][node_id] = "completed"
                    event(run_id, "run_completed", node=node_id)
                    save(run_id, state)
                    return
                state["node_states"][node_id] = "running"
                state["attempts"][node_id] = state["attempts"].get(node_id, 0) + 1
                save(run_id, state)
                event(run_id, "node_started", node=node_id, attempt=state["attempts"][node_id])
            harness = workflow.get("harness", "codex")
            model = workflow.get("model", "gpt-6-luna") if harness == "codex" else None
            output = _run_harness(run_id, state, node_id, node, harness, model, workflow.get("reasoning_effort", "medium"))
            with LOCK:
                state = state_for(run_id)
                state["last_output"] = output
                _collect_artifacts(run_id, state, node_id)
                event(run_id, "node_completed", node=node_id, output=output)
                decision = decide(workflow, state, node_id, output)
                event(run_id, "node_evaluated", node=node_id, passed=not decision["errors"], errors=decision["errors"], decision=decision["status"])
                if decision["status"] == "failed":
                    raise ValueError(decision["error"])
                if decision["status"] == "retry":
                    state["node_states"][node_id] = "retrying"
                    save(run_id, state)
                    event(run_id, "node_retry", node=node_id, errors=decision["errors"])
                else:
                    state["node_states"][node_id] = "completed" if decision["evaluation"] == "passed" else "rejected"
                    state["current_node"] = decision["next_node"]
                    save(run_id, state)
                    event(run_id, "transition_selected", node=node_id, next_node=decision["next_node"], evaluation=decision["evaluation"])
                _checkpoint(run_id, node_id, state)
                completed += 1
    except Exception as exc:
        with LOCK:
            state = state_for(run_id)
            state["run_status"] = "failed"
            state["error"] = str(exc)
            if state.get("current_node"):
                state["node_states"][state["current_node"]] = "failed"
            save(run_id, state)
            event(run_id, "run_failed", node=state.get("current_node"), error=str(exc))
