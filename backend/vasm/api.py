from __future__ import annotations

import base64
import binascii
import shutil
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
from . import runtime
from .runtime import create_run, launch, pause, recover_interrupted_runs, state_for
from .store import DATA_DIR, checked_id, now, project_dir, read_json, read_jsonl, run_dir, workflow_path, write_json
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


class RenameProject(BaseModel):
    name: str


class WorkflowSource(BaseModel):
    source: str


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


@app.post("/api/projects")
def create_project(body: CreateProject) -> dict[str, Any]:
    try:
        path = project_dir(body.id)
        if path.exists():
            raise ValueError("Project already exists")
        path.mkdir(parents=True)
        metadata = {"id": body.id, "name": body.name, "created_at": now()}
        write_json(path / "project.json", metadata)
        blank_workflow = {
            "version": 1,
            "workflow": {"id": body.id, "name": body.name, "version": "0.1.0"},
            "harness": "generic_cli",
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
        runs_directory = DATA_DIR / "runs"
        if runs_directory.exists():
            for state_path in runs_directory.glob("*/state.json"):
                state = read_json(state_path)
                if state and state.get("project_id") == project_id:
                    run_ids.add(state_path.parent.name)
        run_paths = [runs_directory / run_id for run_id in run_ids]
        with runtime.LOCK:
            active_runs = [run_path.name for run_path in run_paths if runtime.WORKERS.get(run_path) and runtime.WORKERS[run_path].is_alive()]
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
        if not target.is_relative_to(base) or not target.is_file() or target.stat().st_size > 2_000_000:
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


@app.post("/api/projects/{project_id}/runs")
def new_run(project_id: str) -> dict[str, Any]:
    try:
        if not project_dir(project_id).exists():
            raise FileNotFoundError(project_id)
        return create_run(project_id)
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
