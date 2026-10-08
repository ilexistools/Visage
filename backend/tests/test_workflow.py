import base64
import sys
import time
from types import SimpleNamespace
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from vasm import api, database, runtime, store
from vasm.workflow import matches


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return TestClient(api.app)


def wait_for(client, run_id, target):
    for _ in range(100):
        result = client.get(f"/api/runs/{run_id}").json()
        if result["state"]["run_status"] == target:
            return result
        time.sleep(0.03)
    pytest.fail(f"Run did not reach {target}: {result['state']}")


def install_test_workflow(client, project_id):
    for name in ("prepare", "evaluate"):
        path = store.project_dir(project_id) / f"skills/{name}/SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# {name}\n", encoding="utf-8")
    workflow = {
        "version": 1,
        "workflow": {"id": project_id, "name": project_id, "version": "0.1.0"},
        "harness": "generic_cli",
        "start": "prepare",
        "nodes": {
            "prepare": {"type": "skill", "label": "Prepare", "skill": {"path": "skills/prepare/SKILL.md"}, "command": [sys.executable, "-c", "import json; print(json.dumps({'status':'prepared'}))"], "next": [{"goto": "evaluate"}]},
            "evaluate": {"type": "skill", "label": "Evaluate", "skill": {"path": "skills/evaluate/SKILL.md"}, "command": [sys.executable, "-c", "import json; print(json.dumps({'status':'approved'}))"], "next": [{"goto": "done"}]},
            "done": {"type": "skill", "label": "Done", "terminal": True},
        },
    }
    response = client.put(f"/api/projects/{project_id}/workflow", json={"source": yaml.safe_dump(workflow, sort_keys=False)})
    assert response.status_code == 200, response.text


def test_new_project_starts_with_an_empty_canvas_and_cannot_run(client):
    assert client.post("/api/projects", json={"id": "blank", "name": "Blank"}).status_code == 200
    response = client.get("/api/projects/blank/workflow").json()
    assert response["workflow"]["nodes"] == {}
    assert response["workflow"]["start"] == ""
    assert response["workflow"]["harness"] == "codex"
    assert response["workflow"]["model"] == "gpt-6-luna"
    assert response["workflow"]["reasoning_effort"] == "medium"
    assert client.get("/api/projects/blank/files").json() == ["workflow.yaml"]
    rejected = client.post("/api/projects/blank/runs")
    assert rejected.status_code == 400
    assert "starting node" in rejected.json()["detail"]


def test_project_files_and_runs_live_in_the_chosen_project_folder(client, tmp_path):
    parent = tmp_path / "workspace"
    parent.mkdir()
    response = client.post("/api/projects", json={"id": "folder-project", "name": "Folder project", "parent_path": str(parent)})
    assert response.status_code == 200, response.text
    project_root = parent / "folder-project"
    assert store.project_dir("folder-project") == project_root
    assert (project_root / "workflow.yaml").is_file()
    install_test_workflow(client, "folder-project")
    run = client.post("/api/projects/folder-project/runs").json()
    assert (project_root / "runs" / run["run_id"] / "state.json").is_file()
    deleted = client.delete("/api/projects/folder-project")
    assert deleted.status_code == 200
    assert not project_root.exists()


def test_codex_harness_receives_selected_model(client, tmp_path, monkeypatch):
    client.post("/api/projects", json={"id": "codex-model", "name": "Codex model"})
    root = store.project_dir("codex-model")
    skill_path = root / "skills/step/SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Step\n", encoding="utf-8")
    run_id = "run-model-test"
    store.run_dir(run_id, "codex-model").mkdir(parents=True)
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        output_file = Path(command[command.index("--output-last-message") + 1])
        output_file.write_text('{"ok": true}', encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)
    state = {"project_id": "codex-model", "data": {}, "last_output": None, "attempts": {"step": 1}}
    result = runtime._run_harness(run_id, state, "step", {"skill": {"path": "skills/step/SKILL.md"}}, "codex", "gpt-6-astra")
    assert commands[0][commands[0].index("--model") + 1] == "gpt-6-astra"
    assert commands[0][commands[0].index("-c") + 1] == 'model_reasoning_effort="medium"'
    assert result == {"ok": True}


def test_project_can_be_renamed_and_deleted(client):
    assert client.post("/api/projects", json={"id": "manage-me", "name": "Original"}).status_code == 200
    renamed = client.put("/api/projects/manage-me", json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"
    assert store.read_json(store.project_dir("manage-me") / "project.json")["name"] == "Renamed"

    deleted = client.delete("/api/projects/manage-me")
    assert deleted.status_code == 200
    assert not store.project_dir("manage-me").exists()
    assert all(project["id"] != "manage-me" for project in client.get("/api/projects").json())


def test_skill_workflow_completes_automatically(client):
    assert client.post("/api/projects", json={"id": "workflow", "name": "Workflow"}).status_code == 200
    install_test_workflow(client, "workflow")
    run = client.post("/api/projects/workflow/runs").json()
    run_id = run["run_id"]
    assert database.list_run_ids("workflow") == [run_id]
    assert client.post(f"/api/runs/{run_id}/start").status_code == 200
    done = wait_for(client, run_id, "completed")
    assert done["state"]["current_node"] == "done"
    assert done["state"]["attempts"] == {"prepare": 1, "evaluate": 1}
    assert any(item["type"] == "run_completed" for item in done["history"])


def test_transition_expressions_are_restricted():
    assert matches('output.status == "approved"', {"output": {"status": "approved"}})
    assert matches("state.attempts.repair < 3", {"state": {"attempts": {"repair": 2}}})
    with pytest.raises(ValueError):
        matches('__import__("os").system("true")', {})


def test_skill_markdown_and_binary_resources_can_be_saved(client):
    client.post("/api/projects", json={"id": "skill-files", "name": "Skill files"})
    markdown = "# Edited Skill\n\nUse the imported reference.\n"
    saved = client.put("/api/projects/skill-files/files/skills/prepare/SKILL.md", json={"content": markdown})
    assert saved.status_code == 200
    assert (store.project_dir("skill-files") / "skills/prepare/SKILL.md").read_text() == markdown

    binary = b"%PDF-1.7\x00reference"
    uploaded = client.put("/api/projects/skill-files/files/skills/prepare/references/guide.pdf", json={
        "content": base64.b64encode(binary).decode(), "encoding": "base64",
    })
    assert uploaded.status_code == 200
    assert (store.project_dir("skill-files") / "skills/prepare/references/guide.pdf").read_bytes() == binary

    traversal = client.put("/api/projects/skill-files/files/skills/prepare/%2E%2E/%2E%2E/%2E%2E/outside.txt", json={"content": "no"})
    assert traversal.status_code == 400


def test_missing_referenced_skill_markdown_is_created_when_opened(client):
    client.post("/api/projects", json={"id": "missing-skill", "name": "Missing skill"})
    root = store.project_dir("missing-skill")
    source = {
        "version": 1,
        "workflow": {"id": "missing-skill", "name": "Missing skill", "version": "0.1.0"},
        "harness": "codex", "start": "step", "nodes": {
            "step": {"type": "skill", "label": "Generated step", "skill": {"path": "skills/generated/SKILL.md"}, "next": [{"goto": "done"}]},
            "done": {"type": "skill", "label": "Done", "terminal": True},
        },
    }
    skill_path = root / "skills/generated/SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Generated step\n")
    saved = client.put("/api/projects/missing-skill/workflow", json={"source": yaml.safe_dump(source, sort_keys=False)})
    assert saved.status_code == 200, saved.text
    skill_path.unlink()
    opened = client.get("/api/projects/missing-skill/files/skills/generated/SKILL.md")
    assert opened.status_code == 200
    assert "Add instructions for this step" in opened.text
    assert (root / "skills/generated/SKILL.md").is_file()
def test_step_and_recovery_preserve_progress(client):
    client.post("/api/projects", json={"id": "steps", "name": "Steps"})
    install_test_workflow(client, "steps")
    run_id = client.post("/api/projects/steps/runs").json()["run_id"]
    client.post(f"/api/runs/{run_id}/step")
    paused = wait_for(client, run_id, "paused")
    assert paused["state"]["current_node"] == "evaluate"
    assert paused["state"]["attempts"] == {"prepare": 1}
    paused["state"]["run_status"] = "running"
    paused["state"]["node_states"]["evaluate"] = "running"
    store.write_json(store.run_dir(run_id) / "state.json", paused["state"])
    runtime.recover_interrupted_runs()
    recovered = client.get(f"/api/runs/{run_id}").json()
    assert recovered["state"]["run_status"] == "paused"
    assert recovered["state"]["node_states"]["evaluate"] == "idle"
    client.post(f"/api/runs/{run_id}/resume")
    done = wait_for(client, run_id, "completed")
    assert done["state"]["attempts"] == {"prepare": 1, "evaluate": 1}
