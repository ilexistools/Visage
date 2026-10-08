"""Export a Visage workflow as a plugin that Claude Code and Codex can run without Visage."""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

from . import engine
from .store import project_dir, read_json, workflow_path
from .workflow import validate_workflow

TEMPLATES = Path(__file__).resolve().parent / "templates"
MARKER = ".visage-export"
SKIP_DIRS = {"runs", "dist", ".visage", "__pycache__", ".git"}


def slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value[:64] or "workflow"


def _copy_step(source_skill: Path, project: Path, target: Path) -> None:
    """Copy a node's Skill folder, renaming SKILL.md to STEP.md so harnesses do not auto-discover it."""
    target.mkdir(parents=True, exist_ok=True)
    folder = source_skill.parent
    if folder != project:
        for item in folder.rglob("*"):
            relative = item.relative_to(folder)
            if item.is_dir() or relative.parts[0] in SKIP_DIRS or item == source_skill:
                continue
            (target / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target / relative)
    (target / "STEP.md").write_text(_strip_frontmatter(source_skill.read_text(encoding="utf-8")), encoding="utf-8")


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---\n") and "\n---" in text[4:]:
        return text[text.index("\n---", 4) + 4:].lstrip("\n")
    return text


def _portable_workflow(workflow: dict[str, Any], name: str) -> dict[str, Any]:
    nodes = {}
    for node_id, node in workflow["nodes"].items():
        keep = {key: node[key] for key in ("label", "description", "terminal", "next", "output_schema", "checks", "max_attempts", "on_fail") if key in node}
        if not node.get("terminal"):
            keep["step"] = f"nodes/{node_id}/STEP.md"
        nodes[node_id] = keep
    return {
        "plugin": name,
        "workflow": workflow.get("workflow", {}),
        "start": workflow["start"],
        "max_steps": workflow.get("max_steps", engine.DEFAULT_MAX_STEPS),
        "nodes": nodes,
    }


def _transition_text(node: dict[str, Any]) -> str:
    parts = [f"`{t['goto']}`" + (f" when `{t['when']}`" if t.get("when") else "") for t in node.get("next", []) or []]
    if node.get("on_fail"):
        parts.append(f"`{node['on_fail']}` if evaluation fails")
    return "; ".join(parts) or "—"


def _ordered(portable: dict[str, Any]) -> list[str]:
    """Nodes in breadth-first order from the start node, then any unreachable ones."""
    order, queue = [], [portable["start"]]
    while queue:
        node_id = queue.pop(0)
        if node_id in order:
            continue
        order.append(node_id)
        node = portable["nodes"][node_id]
        queue.extend(t["goto"] for t in node.get("next", []) or [])
        if node.get("on_fail"):
            queue.append(node["on_fail"])
    return order + [node_id for node_id in portable["nodes"] if node_id not in order]


def _orchestrator(portable: dict[str, Any], description: str) -> str:
    name = portable["plugin"]
    title = portable["workflow"].get("name") or name
    rows = []
    for node_id in _ordered(portable):
        node = portable["nodes"][node_id]
        kind = "final" if node.get("terminal") else "start" if node_id == portable["start"] else "step"
        gate = []
        if node.get("output_schema"):
            gate.append("schema")
        if node.get("checks"):
            gate.append(f"{len(node['checks'])} check(s)")
        if node.get("max_attempts", 1) > 1:
            gate.append(f"up to {node['max_attempts']} attempts")
        summary = (node.get("description") or node.get("label") or node_id).replace("|", "\\|").replace("\n", " ")
        rows.append(f"| `{node_id}` | {kind} | {summary} | {', '.join(gate) or '—'} | {_transition_text(node) if not node.get('terminal') else '—'} |")
    return f"""---
name: {name}
description: {json.dumps(description, ensure_ascii=False)}
---
# {title}

This Skill runs a fixed state-machine workflow. A runner script decides which step comes next and evaluates every step output before the workflow can advance. Never skip, reorder or merge steps, and never invent a step that the runner did not give you.

## Protocol

All commands below use `scripts/flow.py`, located in the same folder as this SKILL.md. Run them with `python3` from the user's working directory.

1. **Start** a run with the user's request as input:
   `python3 <this-skill-folder>/scripts/flow.py start --input '<JSON or text with the user request>'`
   (use `--input-file path.json` for large inputs).
2. The runner prints JSON with `status: "awaiting_output"` and the current step: `node`, `step_file`, `resources_dir`, `input`, `previous_outputs`, `feedback`, `output_contract`, `artifact_dir`, `output_file` and the exact `submit` command.
3. **Execute the step**: read `step_file` and follow it exactly, using `input` and `previous_outputs` as context and files in `resources_dir` as references. Save any files you produce in `artifact_dir`.
4. **Submit**: write the step result as one JSON object to `output_file`, satisfying `output_contract`, then run the `submit` command exactly as printed.
5. Read the runner's reply:
   - `decision: "next"` with `status: "awaiting_output"` → go to step 3 for the new `node`.
   - `decision: "retry"` → the output was rejected; fix every item in `errors`/`feedback` and resubmit the same step.
   - `status: "completed"` → report the final result to the user from `outputs` and `artifact_dir`.
   - `status: "failed"` → stop and report `error` to the user.
6. If you lose track of the run, `python3 <this-skill-folder>/scripts/flow.py next` prints the current step again; `status` shows progress.

Keep going until the run is `completed` or `failed`. Ask the user only when a step's instructions require information that is not available.

## Steps

| Node | Kind | Purpose | Evaluation | Next |
| --- | --- | --- | --- | --- |
{chr(10).join(rows)}
"""


def export_plugin(project_id: str, output_dir: str | Path | None = None, make_zip: bool = True) -> dict[str, Any]:
    project = project_dir(project_id).resolve()
    workflow, warnings = validate_workflow(workflow_path(project_id).read_text(encoding="utf-8"), project, strict=True)
    meta = workflow.get("workflow", {})
    metadata = read_json(project / "project.json", {}) or {}
    name = slug(meta.get("id") or project_id)
    version = str(meta.get("version") or "0.1.0")
    title = meta.get("name") or metadata.get("name") or name
    steps = [node.get("label") or node_id for node_id, node in workflow["nodes"].items() if not node.get("terminal")]
    description = meta.get("description") or f"Run the {title} workflow: a state machine of {len(steps)} evaluated step(s) ({', '.join(steps)}). Use when the user asks to run {title}."

    base = Path(output_dir).expanduser().resolve() if output_dir else project / "dist"
    root = base / name
    if root.exists():
        if not (root / MARKER).exists():
            raise ValueError(f"Refusing to overwrite {root}: it was not created by a Visage export")
        shutil.rmtree(root)
    skill = root / "skills" / name
    (skill / "scripts").mkdir(parents=True)
    (root / MARKER).write_text("Generated by Visage. This folder is replaced on every export.\n", encoding="utf-8")

    portable = _portable_workflow(workflow, name)
    for node_id, node in workflow["nodes"].items():
        if not node.get("terminal"):
            _copy_step(project / node["skill"]["path"], project, skill / "nodes" / node_id)
    (skill / "workflow.json").write_text(json.dumps(portable, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(Path(engine.__file__), skill / "scripts" / "vasm_engine.py")
    shutil.copy2(TEMPLATES / "flow.py", skill / "scripts" / "flow.py")
    (skill / "SKILL.md").write_text(_orchestrator(portable, description), encoding="utf-8")
    (skill / "agents").mkdir()
    (skill / "agents" / "openai.yaml").write_text(
        "interface:\n"
        f"  display_name: {json.dumps(title, ensure_ascii=False)}\n"
        f"  short_description: {json.dumps(description[:120], ensure_ascii=False)}\n"
        f"  default_prompt: {json.dumps(f'Use ${name} to run this workflow on my request.', ensure_ascii=False)}\n",
        encoding="utf-8",
    )

    author = {"name": meta.get("author") or "Visage"}
    manifest = {"name": name, "version": version, "description": description, "author": author, "keywords": ["workflow", "state-machine", "visage"]}
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    codex = {**manifest, "skills": "./skills/", "interface": {
        "displayName": title, "shortDescription": description[:120], "longDescription": description,
        "developerName": author["name"], "category": "Productivity", "capabilities": ["Write"],
        "defaultPrompt": [f"Run {title} on this request."],
    }}
    (root / ".codex-plugin").mkdir()
    (root / ".codex-plugin" / "plugin.json").write_text(json.dumps(codex, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "README.md").write_text(
        f"# {title}\n\n{description}\n\nGenerated by Visage from project `{project_id}` (workflow version {version}).\n\n"
        "## Install\n\n"
        f"- **Claude Code**: `claude --plugin-dir {root}` for a session, or add this folder to a plugin marketplace.\n"
        f"- **Codex**: add this folder as a local plugin (it contains `.codex-plugin/plugin.json`), or copy `skills/{name}` to `~/.codex/skills/`.\n"
        f"- **Any other agent**: give it `skills/{name}/SKILL.md`; the runner needs only `python3`.\n\n"
        "## Run state\n\nRuns are stored in `.visage/runs/<plugin>/` under the working directory (override with `--state-dir` or `VISAGE_STATE_DIR`).\n",
        encoding="utf-8",
    )
    result: dict[str, Any] = {"plugin": name, "version": version, "path": str(root), "warnings": warnings}
    if make_zip:
        archive = base / f"{name}-{version}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for item in sorted(root.rglob("*")):
                if item.is_file() and item.name != MARKER:
                    bundle.write(item, Path(name) / item.relative_to(root))
        result["zip"] = str(archive)
    return result
