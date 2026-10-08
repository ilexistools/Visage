from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

DATA_DIR = Path(os.environ.get("VASM_DATA_DIR", Path(__file__).resolve().parents[2] / "data")).resolve()
IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def checked_id(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError("Invalid identifier")
    return value


def project_dir(project_id: str) -> Path:
    return DATA_DIR / "projects" / checked_id(project_id)


def run_dir(run_id: str) -> Path:
    return DATA_DIR / "runs" / checked_id(run_id)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp = Path(handle.name)
    os.replace(temp, path)


def append_jsonl(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def workflow_path(project_id: str) -> Path:
    return project_dir(project_id) / "workflow.yaml"


def load_workflow(project_id: str) -> dict[str, Any]:
    return yaml.safe_load(workflow_path(project_id).read_text(encoding="utf-8"))
