import asyncio
import json
import subprocess
import sys
import zipfile

import pytest
import yaml
from fastapi.testclient import TestClient

from vasm import api, engine, store
from mcp.server.mcpserver.exceptions import ToolError

from vasm.mcp_server import mcp


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return TestClient(api.app)


def wait_for(client, run_id, targets):
    import time
    for _ in range(200):
        result = client.get(f"/api/runs/{run_id}").json()
        if result["state"]["run_status"] in targets:
            return result
        time.sleep(0.03)
    pytest.fail(f"Run did not finish: {result['state']}")


def emit(payload):
    return [sys.executable, "-c", f"import json; print(json.dumps({payload!r}))"]


def counter_command(path):
    """A command that returns a low score on its first call and a high score afterwards."""
    script = (
        "import json, pathlib\n"
        f"p = pathlib.Path({str(path)!r})\n"
        "n = int(p.read_text()) + 1 if p.exists() else 1\n"
        "p.write_text(str(n))\n"
        "print('Result:\\n```json\\n' + json.dumps({'score': 0.4 if n == 1 else 0.9, 'items': ['a']}) + '\\n```')\n"
    )
    return [sys.executable, "-c", script]


def install(client, project_id, nodes, start="draft"):
    client.post("/api/projects", json={"id": project_id, "name": project_id.title()})
    for node_id, node in nodes.items():
        if not node.get("terminal"):
            path = store.project_dir(project_id) / f"skills/{node_id}/SKILL.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"---\nname: {node_id}\n---\n# {node_id}\n\nDo the {node_id} step.\n", encoding="utf-8")
            (path.parent / "reference.md").write_text("reference", encoding="utf-8")
            node.setdefault("skill", {"path": f"skills/{node_id}/SKILL.md"})
        node.setdefault("type", "skill")
    workflow = {"version": 1, "workflow": {"id": project_id, "name": project_id.title(), "version": "1.2.0"}, "harness": "generic_cli", "start": start, "nodes": nodes}
    response = client.put(f"/api/projects/{project_id}/workflow", json={"source": yaml.safe_dump(workflow, sort_keys=False)})
    assert response.status_code == 200, response.text


SCHEMA = {"type": "object", "required": ["score", "items"], "properties": {"score": {"type": "number", "minimum": 0, "maximum": 1}, "items": {"type": "array", "minItems": 1}}}


def test_expressions_support_membership_length_and_hyphenated_paths():
    context = {"output": {"status": "ok", "items": [1, 2]}, "state": {"outputs": {"find-provisions": {"count": 3}}}}
    assert engine.matches('output.status in ["ok", "done"]', context)
    assert engine.matches('output.status not in ["failed"]', context)
    assert engine.matches("output.items.length >= 2", context)
    assert engine.matches("state.outputs.find-provisions.count == 3", context)
    assert not engine.matches("output.missing > 1", context)


def test_schema_validation_reports_readable_errors():
    errors = engine.validate_schema({"score": 2, "items": [], "extra": 1}, {**SCHEMA, "additionalProperties": False})
    assert "output.score must be <= 1" in errors
    assert "output.items must have at least 1 items" in errors
    assert "output.extra is not allowed" in errors
    assert engine.validate_schema({"score": 0.5, "items": ["x"]}, SCHEMA) == []


def test_parse_output_accepts_fenced_json():
    assert engine.parse_output('Done.\n```json\n{"ok": true}\n```') == {"ok": True}
    assert engine.parse_output("plain text") == {"text": "plain text"}


def test_failed_evaluation_retries_with_feedback_then_advances(client, tmp_path):
    install(client, "gated", {
        "draft": {"command": counter_command(tmp_path / "count"), "output_schema": SCHEMA, "checks": [{"when": "output.score >= 0.8", "message": "Score must be at least 0.8"}], "max_attempts": 2, "next": [{"goto": "done"}]},
        "done": {"terminal": True},
    })
    run_id = client.post("/api/projects/gated/runs", json={"input": {"topic": "x"}}).json()["run_id"]
    client.post(f"/api/runs/{run_id}/start")
    done = wait_for(client, run_id, {"completed", "failed"})
    assert done["state"]["run_status"] == "completed", done["state"].get("error")
    assert done["state"]["attempts"] == {"draft": 2}
    assert done["state"]["data"]["input"] == {"topic": "x"}
    assert done["state"]["data"]["outputs"]["draft"]["score"] == 0.9
    retries = [item for item in done["history"] if item["type"] == "node_retry"]
    assert retries and retries[0]["errors"] == ["Score must be at least 0.8"]


def test_exhausted_evaluation_routes_to_on_fail_or_fails(client):
    install(client, "routed", {
        "draft": {"command": emit({"score": 0.1, "items": ["a"]}), "checks": ["output.score >= 0.8"], "on_fail": "fix", "next": [{"goto": "done"}]},
        "fix": {"command": emit({"fixed": True}), "next": [{"goto": "done"}]},
        "done": {"terminal": True},
    })
    run_id = client.post("/api/projects/routed/runs").json()["run_id"]
    client.post(f"/api/runs/{run_id}/start")
    done = wait_for(client, run_id, {"completed", "failed"})
    assert done["state"]["run_status"] == "completed"
    assert done["state"]["node_states"]["draft"] == "rejected"
    assert done["state"]["data"]["outputs"]["fix"] == {"fixed": True}

    install(client, "strict", {
        "draft": {"command": emit({"score": 0.1}), "output_schema": SCHEMA, "next": [{"goto": "done"}]},
        "done": {"terminal": True},
    })
    run_id = client.post("/api/projects/strict/runs").json()["run_id"]
    client.post(f"/api/runs/{run_id}/start")
    failed = wait_for(client, run_id, {"completed", "failed"})
    assert failed["state"]["run_status"] == "failed"
    assert "output.items is required" in failed["state"]["error"]


def test_incomplete_workflow_saves_with_warnings_but_cannot_run(client):
    client.post("/api/projects", json={"id": "partial", "name": "Partial"})
    source = yaml.safe_dump({"version": 1, "start": "a", "nodes": {"a": {"type": "skill", "skill": {"path": "skills/a/SKILL.md"}}}})
    saved = client.put("/api/projects/partial/workflow", json={"source": source})
    assert saved.status_code == 200
    assert "Workflow needs a terminal node" in saved.json()["warnings"]
    assert client.get("/api/projects/partial/validate").json()["ready"] is False
    assert client.post("/api/projects/partial/runs").status_code == 400
    bad = yaml.safe_dump({"version": 1, "start": "a", "nodes": {"a": {"type": "skill", "skill": {"path": "skills/a/SKILL.md"}, "on_fail": "nope"}}})
    assert client.put("/api/projects/partial/workflow", json={"source": bad}).status_code == 400


def test_exported_plugin_runs_the_state_machine_standalone(client, tmp_path):
    install(client, "attest", {
        "draft": {"label": "Draft", "description": "Write a draft", "output_schema": SCHEMA, "max_attempts": 2, "next": [{"goto": "review"}]},
        "review": {"label": "Review", "next": [{"goto": "done", "when": 'output.verdict == "approved"'}, {"goto": "draft"}]},
        "done": {"terminal": True, "description": "Approved draft"},
    })
    result = client.post("/api/projects/attest/export").json()
    root = store.project_dir("attest") / "dist" / "attest"
    assert result["path"] == str(root)
    assert json.loads((root / ".claude-plugin/plugin.json").read_text())["version"] == "1.2.0"
    assert json.loads((root / ".codex-plugin/plugin.json").read_text())["skills"] == "./skills/"
    skill = root / "skills/attest"
    assert (skill / "SKILL.md").read_text().startswith("---\nname: attest\n")
    assert (skill / "nodes/draft/STEP.md").read_text().startswith("# draft")
    assert (skill / "nodes/draft/reference.md").is_file()
    assert not list(skill.glob("nodes/*/SKILL.md"))
    with zipfile.ZipFile(result["zip"]) as bundle:
        assert "attest/skills/attest/scripts/flow.py" in bundle.namelist()

    state_dir = tmp_path / "plugin-runs"
    flow = [sys.executable, str(skill / "scripts/flow.py"), "--state-dir", str(state_dir)]

    def call(*args):
        completed = subprocess.run([*flow, *args], capture_output=True, text=True)
        return json.loads(completed.stdout)

    step = call("start", "--input", '{"text": "raw"}')
    assert step["node"] == "draft" and step["input"] == {"text": "raw"}
    assert step["output_contract"]["schema"] == SCHEMA
    retry = call("submit", "--output", '{"score": 5}')
    assert retry["decision"] == "retry" and retry["node"] == "draft"
    assert "output.items is required" in retry["feedback"]
    step = call("submit", "--output", '{"score": 0.9, "items": ["x"]}')
    assert step["decision"] == "next" and step["node"] == "review"
    assert step["previous_outputs"]["draft"]["score"] == 0.9
    assert call("submit", "--output", '{"verdict": "changes"}')["node"] == "draft"
    call("submit", "--output", '{"score": 0.95, "items": ["y"]}')
    final = call("submit", "--output", '{"verdict": "approved"}')
    assert final["status"] == "completed" and final["final_state"] == "Approved draft"
    assert call("status")["attempts"] == {"draft": 3, "review": 2}


def test_mcp_tools_build_run_and_export_a_workflow(client):
    async def call(tool_name, **arguments):
        result = await mcp.call_tool(tool_name, arguments)
        assert not result.is_error, result.content
        return result.structured_content.get("result", result.structured_content) if result.structured_content else result.content

    async def scenario():
        await call("create_project", project_id="via-mcp", name="Via MCP")
        await call("configure_workflow", project_id="via-mcp", harness="generic_cli", description="Built over MCP")
        await call("upsert_node", project_id="via-mcp", node_id="write", label="Write", skill_markdown="# Write\n",
                   command=emit({"status": "ok"}), checks=[{"when": 'output.status == "ok"', "message": "Status must be ok"}])
        await call("upsert_node", project_id="via-mcp", node_id="done", terminal=True)
        await call("set_transitions", project_id="via-mcp", node_id="write", transitions=[{"goto": "done"}])
        validation = await call("validate_project", project_id="via-mcp")
        assert validation["ready"], validation
        run = await call("create_run", project_id="via-mcp", input={"q": 1})
        await call("start_run", run_id=run["run_id"])
        wait_for(client, run["run_id"], {"completed"})
        exported = await call("export_plugin", project_id="via-mcp")
        assert exported["plugin"] == "via-mcp"
        await call("remove_node", project_id="via-mcp", node_id="done")
        workflow = (await call("get_workflow", project_id="via-mcp"))["workflow"]
        assert workflow["nodes"]["write"]["next"] == []
        with pytest.raises(ToolError, match="confirm=true"):
            await mcp.call_tool("delete_project", {"project_id": "via-mcp"})

    asyncio.run(scenario())
    assert (store.project_dir("via-mcp") / "skills/write/SKILL.md").read_text() == "# Write\n"
