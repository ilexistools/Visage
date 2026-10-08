"""SQLite catalog for projects and runs; detailed records remain in run files."""

import sqlite3
import threading
from contextlib import contextmanager
from collections.abc import Iterator
from typing import Any

from . import store

_INITIALIZED: set[str] = set()
_INITIALIZATION_LOCK = threading.Lock()


def connect() -> sqlite3.Connection:
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    database_path = store.DATA_DIR / "vasm.sqlite"
    connection = sqlite3.connect(database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    key = str(database_path.resolve())
    if key not in _INITIALIZED:
        with _INITIALIZATION_LOCK:
            if key not in _INITIALIZED:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS projects (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        root_path TEXT
                    );
                    CREATE TABLE IF NOT EXISTS runs (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        current_node TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        FOREIGN KEY (project_id) REFERENCES projects(id)
                    );
                    CREATE INDEX IF NOT EXISTS runs_by_project ON runs(project_id, created_at DESC);
                """)
                columns = {row[1] for row in connection.execute("PRAGMA table_info(projects)")}
                if "root_path" not in columns:
                    connection.execute("ALTER TABLE projects ADD COLUMN root_path TEXT")
                connection.commit()
                _INITIALIZED.add(key)
    return connection


def initialize() -> None:
    connection = connect()
    connection.close()


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def save_project(project: dict[str, Any]) -> None:
    root_path = str(project.get("root_path") or (store.DATA_DIR / "projects" / project["id"]).resolve())
    store.register_project_dir(project["id"], root_path)
    with session() as db:
        db.execute("INSERT OR REPLACE INTO projects (id, name, created_at, root_path) VALUES (?, ?, ?, ?)", (project["id"], project["name"], project["created_at"], root_path))


def rename_project(project_id: str, name: str) -> None:
    with session() as db:
        cursor = db.execute("UPDATE projects SET name = ? WHERE id = ?", (name, project_id))
        if cursor.rowcount == 0:
            raise FileNotFoundError(project_id)


def delete_project(project_id: str) -> None:
    with session() as db:
        db.execute("DELETE FROM runs WHERE project_id = ?", (project_id,))
        cursor = db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cursor.rowcount == 0:
            raise FileNotFoundError(project_id)
    store.unregister_project_dir(project_id)


def list_projects() -> list[dict[str, Any]]:
    with session() as db:
        projects = [dict(row) for row in db.execute("SELECT id, name, created_at, root_path FROM projects ORDER BY created_at DESC")]
        for project in projects:
            if project.get("root_path"):
                store.register_project_dir(project["id"], project["root_path"])
        return projects


def project_root(project_id: str) -> str | None:
    with session() as db:
        row = db.execute("SELECT root_path FROM projects WHERE id = ?", (project_id,)).fetchone()
        return row["root_path"] if row else None


def project_id_for_run(run_id: str) -> str | None:
    with session() as db:
        row = db.execute("SELECT project_id FROM runs WHERE id = ?", (run_id,)).fetchone()
        return row["project_id"] if row else None


def save_run(state: dict[str, Any]) -> None:
    with session() as db:
        db.execute("""INSERT OR REPLACE INTO runs (id, project_id, status, current_node, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?)""", (
            state["run_id"], state["project_id"], state["run_status"], state["current_node"], state["created_at"], state["updated_at"]
        ))


def list_run_ids(project_id: str) -> list[str]:
    with session() as db:
        return [row["id"] for row in db.execute("SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC", (project_id,))]


def bootstrap() -> None:
    """Index existing file-backed projects and runs after an upgrade."""
    initialize()
    for path in (store.DATA_DIR / "projects").glob("*/project.json"):
        project = store.read_json(path)
        if project:
            project.setdefault("root_path", str(path.parent.resolve()))
            save_project(project)
    list_projects()
    for path in (store.DATA_DIR / "runs").glob("*/state.json"):
        state = store.read_json(path)
        if state:
            save_run(state)
