from __future__ import annotations

import base64
import binascii
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
import yaml

from . import __version__
from . import database
from . import exporter
from . import runtime
from . import store
from .runtime import create_run, launch, pause, recover_interrupted_runs, state_for
from .store import checked_id, now, project_dir, read_json, read_jsonl, run_dir, workflow_path, write_json
from .workflow import validate_workflow

@asynccontextmanager
async def lifespan(_: FastAPI):
    database.bootstrap()
    recover_interrupted_runs()
    yield


app = FastAPI(title="Visual Agentic State Machine", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])


class CreateProject(BaseModel):
    id: str
    name: str
    parent_path: str | None = None


class RenameProject(BaseModel):
    name: str


class WorkflowSource(BaseModel):
    source: str


class RunRequest(BaseModel):
    input: Any = None


class ExportRequest(BaseModel):
    output_dir: str | None = None


class ProjectFileContent(BaseModel):
    content: str
    encoding: Literal["utf-8", "base64"] = "utf-8"


def error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=404 if isinstance(exc, FileNotFoundError) else 400, detail=str(exc))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/api/projects")
def list_projects() -> list[dict[str, Any]]:
    return database.list_projects()


@app.get("/api/folder-picker")
def folder_picker() -> dict[str, str]:
    """Open a native folder chooser on the local machine running the backend."""
    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a location for the Visage project")'],
                capture_output=True, text=True, timeout=180,
            )
        elif os.name == "nt":
            script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}"
            result = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True, text=True, timeout=180)
        else:
            picker = shutil.which("zenity") or shutil.which("kdialog")
            if not picker:
                raise ValueError("Install zenity or kdialog to use the folder picker, or enter a folder path manually.")
            args = [picker, "--file-selection", "--directory", "--title=Choose a location for the Visage project"] if picker.endswith("zenity") else [picker, "--getexistingdirectory", ".", "--title", "Choose a location for the Visage project"]
            result = subprocess.run(args, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            return {"path": ""}
        return {"path": result.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not open the folder picker: {exc}") from exc


@app.post("/api/projects")
def create_project(body: CreateProject) -> dict[str, Any]:
    try:
        name = body.name.strip()
        if not name:
            raise ValueError("Project name cannot be empty")
        if any(project["id"] == body.id for project in database.list_projects()):
            raise ValueError("Project identifier already exists")
        if body.parent_path:
            parent = Path(body.parent_path).expanduser().resolve()
            if not parent.is_dir():
                raise ValueError("Choose an existing parent folder")
            path = (parent / checked_id(body.id)).resolve()
            if not path.is_relative_to(parent):
                raise ValueError("Invalid project folder")
        else:
            path = project_dir(body.id)
        if path.exists():
            raise ValueError("A project folder with this name already exists in the selected location")
        path.mkdir(parents=True)
        metadata = {"id": body.id, "name": name, "created_at": now(), "root_path": str(path)}
        store.register_project_dir(body.id, path)
        write_json(path / "project.json", metadata)
        blank_workflow = {
            "version": 1,
            "workflow": {"id": body.id, "name": name, "version": "0.1.0"},
            "harness": "codex",
            "model": "gpt-6-luna",
            "reasoning_effort": "medium",
            "start": "",
            "nodes": {},
        }
        workflow_path(body.id).write_text(yaml.safe_dump(blank_workflow, sort_keys=False), encoding="utf-8")
        database.save_project(metadata)
        return metadata
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.put("/api/projects/{project_id}")
def rename_project(project_id: str, body: RenameProject) -> dict[str, Any]:
    try:
        path = project_dir(project_id)
        metadata_path = path / "project.json"
        metadata = read_json(metadata_path)
        if metadata is None:
            raise FileNotFoundError(project_id)
        name = body.name.strip()
        if not name:
            raise ValueError("Project name cannot be empty")
        metadata["name"] = name
        write_json(metadata_path, metadata)
        database.rename_project(project_id, name)
        return metadata
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict[str, str]:
    try:
        path = project_dir(project_id)
        if not path.is_dir():
            raise FileNotFoundError(project_id)
        run_ids = set(database.list_run_ids(project_id))
        runs_directory = store.DATA_DIR / "runs"
        if runs_directory.exists():
            for state_path in runs_directory.glob("*/state.json"):
                state = read_json(state_path)
                if state and state.get("project_id") == project_id:
                    run_ids.add(state_path.parent.name)
        run_paths = [run_dir(run_id) for run_id in run_ids]
        with runtime.LOCK:
            active_runs = [run_id for run_id in run_ids if runtime.WORKERS.get(run_id) and runtime.WORKERS[run_id].is_alive()]
            if active_runs:
                raise ValueError("Cannot delete a project while one of its runs is active")
            for run_path in run_paths:
                shutil.rmtree(run_path)
            shutil.rmtree(path)
            database.delete_project(project_id)
        return {"id": project_id, "status": "deleted"}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/workflow")
def get_workflow(project_id: str) -> dict[str, Any]:
    try:
        source = workflow_path(project_id).read_text(encoding="utf-8")
        workflow, warnings = validate_workflow(source, project_dir(project_id))
        return {"source": source, "workflow": workflow, "warnings": warnings}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.put("/api/projects/{project_id}/workflow")
def put_workflow(project_id: str, body: WorkflowSource) -> dict[str, Any]:
    try:
        path = project_dir(project_id)
        if not path.exists():
            raise FileNotFoundError(project_id)
        workflow, warnings = validate_workflow(body.source, path)
        workflow_path(project_id).write_text(body.source, encoding="utf-8")
        return {"workflow": workflow, "warnings": warnings}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/files")
def project_files(project_id: str) -> list[str]:
    try:
        path = project_dir(project_id)
        if not path.exists():
            raise FileNotFoundError(project_id)
        return [str(file.relative_to(path)) for file in path.rglob("*") if file.is_file() and file.name != "project.json"]
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/files/{file_path:path}")
def project_file(project_id: str, file_path: str) -> PlainTextResponse:
    try:
        base = project_dir(project_id).resolve()
        target = (base / file_path).resolve()
        if not target.is_relative_to(base):
            raise ValueError("Invalid project file")
        if not target.is_file():
            workflow = yaml.safe_load(workflow_path(project_id).read_text(encoding="utf-8")) or {}
            referenced = any(
                isinstance(node, dict)
                and isinstance(node.get("skill"), dict)
                and node["skill"].get("path") == file_path
                for node in workflow.get("nodes", {}).values()
            )
            if not referenced or Path(file_path).name != "SKILL.md" or not Path(file_path).parts or Path(file_path).parts[0] != "skills":
                raise ValueError("Invalid project file")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# Step\n\nAdd instructions for this step.\n", encoding="utf-8")
        if target.stat().st_size > 2_000_000:
            raise ValueError("Invalid project file")
        return PlainTextResponse(target.read_text(encoding="utf-8"))
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.put("/api/projects/{project_id}/files/{file_path:path}")
def put_project_file(project_id: str, file_path: str, body: ProjectFileContent) -> dict[str, Any]:
    try:
        base = project_dir(project_id).resolve()
        if not base.is_dir():
            raise FileNotFoundError(project_id)
        target = (base / file_path).resolve()
        if not target.is_relative_to(base) or target == base:
            raise ValueError("Invalid project file path")
        try:
            content = base64.b64decode(body.content, validate=True) if body.encoding == "base64" else body.content.encode("utf-8")
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid file content encoding") from exc
        if len(content) > 25_000_000:
            raise ValueError("Project files must be smaller than 25 MB")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return {"path": str(target.relative_to(base)), "size": len(content)}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/validate")
def validate_project(project_id: str) -> dict[str, Any]:
    """Report whether the workflow is ready to run or export."""
    try:
        source = workflow_path(project_id).read_text(encoding="utf-8")
        _, warnings = validate_workflow(source, project_dir(project_id))
        try:
            validate_workflow(source, project_dir(project_id), strict=True)
            return {"ready": True, "errors": [], "warnings": warnings}
        except ValueError as exc:
            return {"ready": False, "errors": [str(exc)], "warnings": warnings}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/projects/{project_id}/export")
def export_project(project_id: str, body: ExportRequest | None = None) -> dict[str, Any]:
    try:
        if not project_dir(project_id).exists():
            raise FileNotFoundError(project_id)
        return exporter.export_plugin(project_id, body.output_dir if body else None)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/export.zip")
def download_export(project_id: str) -> FileResponse:
    try:
        if not project_dir(project_id).exists():
            raise FileNotFoundError(project_id)
        result = exporter.export_plugin(project_id)
        return FileResponse(result["zip"], media_type="application/zip", filename=Path(result["zip"]).name)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/projects/{project_id}/runs")
def new_run(project_id: str, body: RunRequest | None = None) -> dict[str, Any]:
    try:
        if not project_dir(project_id).exists():
            raise FileNotFoundError(project_id)
        return create_run(project_id, body.input if body else None)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/projects/{project_id}/runs")
def project_runs(project_id: str) -> list[dict[str, Any]]:
    try:
        checked_id(project_id)
        return [read_json(run_dir(run_id) / "state.json") for run_id in database.list_run_ids(project_id)]
    except ValueError as exc:
        raise error(exc) from exc


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    try:
        state = state_for(run_id)
        return {"state": state, "history": read_jsonl(run_dir(run_id) / "history.jsonl"), "artifacts": read_json(run_dir(run_id) / "artifacts.json", [])}
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/runs/{run_id}/start")
def start(run_id: str) -> dict[str, Any]:
    try:
        return launch(run_id)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/runs/{run_id}/resume")
def resume(run_id: str) -> dict[str, Any]:
    return start(run_id)


@app.get("/api/runs/{run_id}/state")
def get_state(run_id: str) -> dict[str, Any]:
    try:
        return state_for(run_id)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/runs/{run_id}/artifacts")
def get_artifacts(run_id: str) -> list[dict[str, Any]]:
    try:
        state_for(run_id)
        return read_json(run_dir(run_id) / "artifacts.json", [])
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/runs/{run_id}/step")
def step(run_id: str) -> dict[str, Any]:
    try:
        return launch(run_id, single_step=True)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.post("/api/runs/{run_id}/pause")
def pause_run(run_id: str) -> dict[str, Any]:
    try:
        return pause(run_id)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc


@app.get("/api/runs/{run_id}/artifacts/{file_path:path}")
def artifact(run_id: str, file_path: str) -> FileResponse:
    try:
        base = (run_dir(run_id) / "artifacts").resolve()
        target = (base / file_path).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise FileNotFoundError(file_path)
        manifest = read_json(run_dir(run_id) / "artifacts.json", [])
        if not any(item["path"] == file_path for item in manifest):
            raise FileNotFoundError(file_path)
        return FileResponse(target)
    except (ValueError, FileNotFoundError) as exc:
        raise error(exc) from exc
