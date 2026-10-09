# Testing workflows and harnesses

Visage tests at two levels:

| Level | Question | Agent involved | Cost |
| --- | --- | --- | --- |
| **Scenarios** | Does the workflow route the way I designed it? | No: results are scripted | Free and instant |
| **Conformance** | Does this harness follow the workflow protocol? | Yes: a real Claude Code, Codex or other CLI run | Model usage per run |

## Scenarios

A scenario scripts the result of each step and states the path you expect. Visage simulates it with the same rules as the exported runner (`decide` in `engine.ts`), so a passing scenario routes the same way in a real run. Scenarios test routing, not the product: they do not run postconditions, and a scripted `0.92` says nothing about whether the artifact works.

Scenarios live in `scenarios.yaml` in the project folder. For the review workflow in [workflow-format.md](workflow-format.md):

```yaml
scenarios:
  - name: Approved after one revision
    input: {topic: MCP servers}          # becomes state.input
    results:
      review: [changes, approved]        # outputs review submits, in order
    expect:
      path: [draft, review, draft, review, published]
      status: completed
      final: published

  - name: Two invalid answers fall back to on_fail
    results:
      review: [maybe, {result: 42, reason: wrong type}]
    expect: {path: [draft, review, review, archive], final: archive}

  - name: A third revision is not scripted, so the run stops
    results: {review: [changes, changes]}
    expect: {status: failed, error: No result scripted for review}
```

- **`results`**: for each step, the outputs it submits in order. Every submission, retries included, uses the next one. A plain value is shorthand for `{"result": value}`; give a full object to test invalid results or extra keys. Steps without an evaluation default to `{}`. An evaluated step with no scripted output left fails the scenario (`No result scripted for review (submission 2)`).
- **`expect`** (all optional):
  - `path`: every step submitted, in order, then the final state. A retried step appears once per submission.
  - `status`: `completed` or `failed`.
  - `final`: the final state reached.
  - `error`: text the failure message must contain.

  A scenario without `expect.status` fails when the run fails.

Running scenarios:

- **Editor**: the flask button in the top bar opens *Workflow scenarios*. Edit the YAML, then **Run** (it runs the text as shown, saved or not) and **Save**. Click a result to highlight its path on the canvas.
- **MCP**: `test_workflow` with `project_id`, and optionally `scenarios` (YAML to run without saving). Write the file with `write_file` (`scenarios.yaml`).
- **API**: `POST /api/projects/{id}/test` with `{"source": "<yaml>"}`, or an empty body to use the saved file.

Result of `test_workflow`:

```json
{ "total": 2, "passed": 1, "failed": 1, "results": [
  { "name": "Rejected drafts are archived", "passed": false, "status": "completed",
    "path": ["draft", "review", "archive"], "final": "archive",
    "steps": [{ "node": "draft", "output": {}, "decision": "next", "errors": [], "next_node": "review" }],
    "mismatches": ["expected to end in published, ended in archive"] } ] }
```

Good practice: one scenario per result of every evaluated step, one for each loop exit, and one for each `on_fail` route.

## Harness conformance

The conformance kit runs a probe workflow through a real harness and audits the run from the runner's history. It shows whether the agent:

- started the runner instead of answering directly;
- used a single run and completed it;
- followed the expected path;
- read every step: each step's Skill contains a random **canary** that must come back in its output;
- resubmitted after an invalid result.

```bash
node server/visage.js conformance --harness claude --model claude-sonnet-5-5
node server/visage.js conformance --harness codex --runs 3
node server/visage.js conformance --command 'my-agent --cwd {workdir} {prompt}'
node server/visage.js conformance --list
```

(From a repository checkout, use `server/build/visage.js` after `npm run build`.)

| Option | Default | Meaning |
| --- | --- | --- |
| `--harness` | `claude` | `claude` loads the probe with `--plugin-dir`, so Skill discovery is tested too. `codex` runs `codex exec --full-auto` and names the Skill file in the prompt. |
| `--command` | | Any other CLI. Placeholders: `{prompt}`, `{plugin}`, `{skill}`, `{workdir}`, `{input_file}`, `{model}` (shell-quoted). |
| `--model` | harness default | Model passed to the harness. |
| `--bin` | `claude` / `codex` | Path of the harness executable. |
| `--scenario` | all | Comma-separated subset. |
| `--runs` | 1 | Runs per scenario; agents are not deterministic, so several runs show a pass rate. |
| `--timeout` | 600 | Seconds per run. |
| `--out` | a temporary folder | Where the probe, each run's folder and `report.json` go. |

Probe scenarios:

| Scenario | Behaviour tested |
| --- | --- |
| `loop` | A predicate answers no, the run goes through a fix step and back to the check. |
| `retry` | The step submits a deliberately invalid result, gets feedback and resubmits. |
| `score-high` | A score at or above the threshold takes the upper arc. |
| `score-low` | A score below the threshold takes the otherwise arc. |

Each run happens in its own folder (`runs/<scenario>-<n>/`) with `VISAGE_STATE_DIR` pointing the runner there, plus the harness output (`harness.stdout.txt`, `harness.stderr.txt`). The command exits with 0 when every run passed. `report.json` lists every check:

```json
{ "harness": "claude", "model": "claude-sonnet-5-5", "total": 1, "passed": 1, "reports": [
  { "scenario": "retry", "attempt": 1, "passed": true, "seconds": 56, "exit_code": 0, "timed_out": false,
    "path": ["intake", "classify", "strict", "strict", "done_beta"],
    "checks": [{ "name": "started the runner", "passed": true }, { "name": "retried strict after feedback", "passed": true }] } ] }
```

**Permissions and cost.** Agents run without supervision in the run folder: Claude Code gets `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` with `acceptEdits`; Codex runs with `--full-auto`. Every run uses model tokens. Start with one scenario and one run.

## Audit trail

Exported runs write `history.jsonl` in their run folder, one event per line, which the kit reads and you can inspect after any real run:

```json
{"timestamp":"...","event":"start","status":"running","current_node":"intake"}
{"timestamp":"...","event":"submit","node":"strict","attempt":1,"decision":"retry","errors":["output.result must be of type boolean"],"result":"not-a-boolean","status":"running","current_node":"strict"}
{"timestamp":"...","event":"submit","node":"strict","attempt":2,"decision":"next","errors":[],"result":true,"next_node":"done_beta","status":"completed","current_node":"done_beta"}
```

When a final state has a postcondition, the event that reaches it also carries `postcondition: {node, command, passed, exit_code, output}`, and its `status` is `failed` when the check failed.

Every submitted output is also kept in `outputs/NNN-<step>.json`.
