# Visage for agent harnesses

Visage lets an agent (Claude Code, Codex or any MCP client) design state-machine workflows of Skills, show them in a visual editor and export them as plugins. It ships as one plugin that contains:

- the **`visage` MCP server**: 19 tools to create, edit, validate, test and export workflows;
- the **`visage` Skill**: tells the agent how to use those tools well;
- the **visual editor**, served by the same process at `http://127.0.0.1:4317`.

Requirements: Node.js 20 or later. Nothing else is installed: the server is a single file.

## Install

Build the plugin from the repository (`cd server && npm install && npm run package`), or use a released `visage-<version>.zip`. The plugin folder is `server/dist/visage`.

### Claude Code

```bash
claude --plugin-dir /path/to/visage          # this session only
```
or add the folder to a plugin marketplace. The plugin registers the MCP server (`.mcp.json`) and the Skill.

### Codex

Add the folder as a local plugin; Codex reads `.codex-plugin/plugin.json`, which points to the MCP configuration in `.codex-mcp.json` and to the Skill.

### Any MCP client (MCP only, without the Skill)

```bash
claude mcp add visage -- node /path/to/visage/server/visage.js --stdio
codex mcp add visage -- node /path/to/visage/server/visage.js --stdio
```

Generic JSON configuration:
```json
{ "mcpServers": { "visage": { "command": "node", "args": ["/path/to/visage/server/visage.js", "--stdio"] } } }
```

Clients that support Streamable HTTP can connect to `http://127.0.0.1:4317/mcp` while Visage runs (`node server/visage.js` starts it without stdio). The MCP server's instructions summarise the workflow model, so a client without the Skill still gets the essentials; give it [references/mcp-tools.md](references/mcp-tools.md) for the details.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--stdio` | off | Speak MCP on standard input/output (what harnesses use). The editor is still served. |
| `--port N` / `VISAGE_PORT` | 4317 | Editor, REST API and HTTP MCP port. The next free port is used when it is taken. |
| `--open` | off | Open the editor in the browser on start. |
| `--no-ui` | off | MCP only, no editor. |
| `VISAGE_DATA_DIR` | `~/.visage` | Folder of the project catalog (`projects.json`) and default project location. |

When several sessions start Visage, the first one serves the editor and the others reuse it, as long as they use the same data folder.

## Documentation

| File | Read it when |
| --- | --- |
| [SKILL.md](SKILL.md) | Always: the procedure the agent follows. |
| [references/mcp-tools.md](references/mcp-tools.md) | Calling tools: arguments, results, errors, examples. |
| [references/workflow-format.md](references/workflow-format.md) | Reading or writing `workflow.yaml`, expressions, validation messages. |
| [references/authoring-guide.md](references/authoring-guide.md) | Designing a workflow and writing step Skills. |
| [references/exported-plugins.md](references/exported-plugins.md) | Installing an exported workflow and its run protocol. |
| [references/testing.md](references/testing.md) | Testing routing with scenarios, and checking a harness with the conformance kit. |

## Security

The server listens on `127.0.0.1` only and rejects requests from other websites (by `Host`, `Origin` and `Sec-Fetch-Site`), because the API writes files. Project files are kept inside their project folder. Exported workflows run with the permissions of the harness that runs them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The MCP server does not start | Check `node --version` (20+). Run `node server/visage.js --stdio` by hand: errors go to standard error. |
| `open_editor` fails | The server was started with `--no-ui`, or ports 4317–4326 are taken; use `--port`. |
| The editor shows other projects than the agent | The two processes use different `VISAGE_DATA_DIR` values. |
| `Another Visage process is busy with this file; try again` | Two sessions saved the same project at once; retry. |
| A tool says `Project not found` | Call `list_projects`; projects are identified by `id`, not by name. |
| An exported workflow fails with `No transition matched` | A step returned a result with no arc; run `validate_project` and add the missing arc. |
