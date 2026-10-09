import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { exportPlugin } from './exporter.ts'
import { workflowToMermaid } from './mermaid.ts'
import { SCENARIOS_FILE, testWorkflow } from './scenarios.ts'
import * as projects from './projects.ts'
import { badRequest } from './store.ts'
import { VERSION } from './version.ts'

export const INSTRUCTIONS = `Visage designs state-machine workflows of agent Skills and exports them as plugins for Claude Code and Codex. It does not run workflows.

A project is a folder with workflow.yaml and one skills/<step>/SKILL.md per step. Changes are saved at once and appear in the visual editor (open_editor).

Procedure: list_projects (reuse an existing project) → create_project → configure_workflow (description = when to use the exported Skill)
→ upsert_node for each step with label, description and skill_markdown (the first step created is the start)
→ evaluation on steps whose result picks the next step → upsert_node terminal=true for each end state
→ set_transitions for every step → validate_project (fix errors and warnings) → export_plugin. export_diagram returns a Mermaid diagram.

Evaluation: the step returns {"result": ..., "reason": "..."}; evaluation.type is predicate (true/false), choice (one of options) or score (0 to 1),
with a question saying what to decide. Steps that only produce files need none. An invalid result is tried again with feedback, up to max_attempts tries in total (default 1 = no retry), then goes to on_fail or fails the run.

Skills are procedures, not prompts: the agent running a step sees only its Skill, the run input and earlier outputs. Each skill_markdown needs
a goal, inputs (exact keys and files), a numbered procedure with concrete methods, quality criteria (definition of done), decision rules for
every result of an evaluated step, failure handling and the JSON it returns. Write one Skill at a time; fix any "shallow Skill" warning.

Arcs: set_transitions replaces all arcs of a step; the first arc whose when matches is taken; omit when on the last arc for "otherwise" (an empty when is rejected).
Route with output.result == true / == false (predicate), output.result == "option" (choice), output.result >= 0.8 (score; also >, <, <=).
when is <path> <op> <literal>: path starts with output. or state. (state.input, state.outputs.<step>.<key>, state.attempts.<step>);
ops ==, !=, <, <=, >, >=, in, not in. A warning "no arc for result X" means that result would fail the run.
state.attempts.<step> counts every submission of a step; max_attempts counts only consecutive invalid results, and a valid one resets it.

Steps share files through the run's artifact_dir. Put names every step must agree on (files, paths, test hooks) in one project file and list it in
configure_workflow shared_references; every step receives it. A final node may have a postcondition {command, message?, timeout_seconds?}:
the exported runner runs it when the run arrives there and reports failed unless it exits 0. Use it on success states to check the product, not the workflow.

write_file refuses workflow.yaml and project.json; use the workflow tools. delete_project needs confirm=true and is permanent.`

type Context = { editorUrl: () => Promise<string | null> }

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** Wrap a handler so thrown errors become MCP tool errors with a readable message. */
function handler<A>(run: (args: A) => unknown | Promise<unknown>) {
  return async (args: A) => {
    try {
      return reply(await run(args))
    } catch (error) {
      return { ...reply((error as Error).message), isError: true }
    }
  }
}

export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(command, args as string[], { stdio: 'ignore', detached: true }).unref()
}

const transition = z.object({ goto: z.string(), when: z.string().optional(), label: z.string().optional() })

export function createMcpServer(context: Context): McpServer {
  const server = new McpServer({ name: 'visage', version: VERSION }, { instructions: INSTRUCTIONS })
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, run: (args: z.infer<z.ZodObject<S>>) => unknown) =>
    server.registerTool(name, { description, inputSchema }, handler(run) as never)

  tool('list_projects', 'List Visage projects with their folders.', {}, () => projects.listProjects())
  tool('create_project', 'Create a project with an empty workflow. project_id: letters, digits, - and _. parent_path: optional existing folder (default ~/.visage/projects).',
    { project_id: z.string(), name: z.string(), parent_path: z.string().optional() },
    ({ project_id, name, parent_path }) => projects.createProject({ id: project_id, name, parent_path }))
  tool('delete_project', 'Permanently delete a project folder and its Skills. Requires confirm=true.',
    { project_id: z.string(), confirm: z.boolean().default(false) },
    ({ project_id, confirm }) => {
      if (!confirm) throw badRequest('Pass confirm=true to delete the project and all its files')
      return projects.deleteProject(project_id)
    })

  tool('get_workflow', 'Return the workflow YAML source, the parsed workflow and validation warnings.', { project_id: z.string() }, ({ project_id }) => projects.getWorkflow(project_id))
  tool('put_workflow', 'Replace the whole workflow with YAML source. Structural errors are rejected; readiness issues come back as warnings.',
    { project_id: z.string(), source: z.string() }, ({ project_id, source }) => projects.putWorkflow(project_id, source))
  tool('configure_workflow', 'Change workflow-level settings: display name, description (used as the exported Skill description), version, max_steps and shared_references (project files every step receives; [] clears them).',
    {
      project_id: z.string(), name: z.string().optional(), description: z.string().optional(), version: z.string().optional(), max_steps: z.number().int().optional(),
      shared_references: z.array(z.string()).optional().describe('Project file paths, e.g. ["references/CONTRACT.md"]'),
    },
    ({ project_id, ...settings }) => projects.configureWorkflow(project_id, settings))
  tool('upsert_node', `Create or update a Skill node. Only given fields change.
skill_markdown writes the node's SKILL.md (default path skills/<node_id>/SKILL.md): a full procedure with goal, inputs, numbered
steps, quality criteria, decision rules and output JSON; the reply warns when it is shallow.
evaluation is {type: predicate|choice|score, question?, options? (choice only)}; pass null to remove it. max_attempts and on_fail
apply when the result is invalid; on_fail: "" clears it. postcondition (final nodes only) is a shell command the exported runner runs
when the run arrives there; the run fails unless it exits 0; pass null to remove it. The first node created becomes the start node.`,
    {
      project_id: z.string(), node_id: z.string(), label: z.string().optional(), description: z.string().optional(),
      skill_markdown: z.string().optional(), skill_path: z.string().optional(), terminal: z.boolean().optional(),
      evaluation: z.object({
        type: z.enum(['predicate', 'choice', 'score']),
        question: z.string().optional().describe('What the step must decide, e.g. "Does the game pass all acceptance criteria?"'),
        options: z.array(z.string()).optional().describe('Choice only: the possible results'),
      }).nullable().optional(),
      max_attempts: z.number().int().min(1).max(20).optional(), on_fail: z.string().optional(),
      postcondition: z.object({
        command: z.string().describe('Shell command run from the working directory; VISAGE_ARTIFACT_DIR, VISAGE_RUN_DIR and VISAGE_RUN_ID are set'),
        message: z.string().optional().describe('What the command proves, shown when it fails'),
        timeout_seconds: z.number().int().min(1).max(3600).optional(),
      }).nullable().optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    },
    ({ project_id, node_id, ...input }) => projects.upsertNode(project_id, node_id, input))
  tool('remove_node', 'Remove a node and every transition or on_fail route pointing to it. The Skill file is kept.',
    { project_id: z.string(), node_id: z.string() }, ({ project_id, node_id }) => projects.removeNode(project_id, node_id))
  tool('set_transitions', 'Replace the outgoing transitions of a node. Order matters: the first matching `when` wins; omit `when` for the default.',
    { project_id: z.string(), node_id: z.string(), transitions: z.array(transition) },
    ({ project_id, node_id, transitions }) => projects.setTransitions(project_id, node_id, transitions))
  tool('set_start', 'Make a node the initial state.', { project_id: z.string(), node_id: z.string() }, ({ project_id, node_id }) => projects.setStart(project_id, node_id))
  tool('validate_project', 'Check whether the workflow is ready to export; returns errors and warnings.', { project_id: z.string() }, ({ project_id }) => projects.validateProject(project_id))

  tool('test_workflow', `Simulate scenarios without running any agent: scripted step results must produce the expected path. Uses ${SCENARIOS_FILE} in the project, or the YAML given in scenarios (not saved). Returns pass/fail, the path taken and mismatches per scenario.`,
    { project_id: z.string(), scenarios: z.string().optional().describe('Scenarios YAML to run instead of the saved file') },
    ({ project_id, scenarios }) => testWorkflow(project_id, scenarios))

  tool('list_files', 'List files in the project folder.', { project_id: z.string() }, ({ project_id }) => projects.listFiles(project_id))
  tool('read_file', 'Read a text file from the project (Skills, references, workflow.yaml).',
    { project_id: z.string(), path: z.string() }, ({ project_id, path }) => projects.readFile(project_id, path))
  tool('write_file', 'Write a project file, e.g. a Skill or a reference. encoding: utf-8 or base64.',
    { project_id: z.string(), path: z.string(), content: z.string(), encoding: z.enum(['utf-8', 'base64']).default('utf-8') },
    ({ project_id, path, content, encoding }) => projects.writeFile(project_id, path, content, encoding))

  tool('delete_file', 'Delete a project file, e.g. a reference imported for a Skill. workflow.yaml, project.json and Skills used by steps cannot be deleted.',
    { project_id: z.string(), path: z.string() }, ({ project_id, path }) => projects.deleteFile(project_id, path))
  tool('export_plugin', 'Export the workflow as a plugin for Claude Code and Codex (folder + zip). Default location: <project>/dist.',
    { project_id: z.string(), output_dir: z.string().optional() }, ({ project_id, output_dir }) => exportPlugin(project_id, output_dir))
  tool('export_diagram', 'Return the workflow as a Mermaid flowchart (text) for READMEs, pull requests and docs; it renders on GitHub.',
    { project_id: z.string() }, ({ project_id }) => workflowToMermaid(projects.getWorkflow(project_id).workflow))
  tool('open_editor', 'Return the URL of the Visage visual editor (optionally for one project) and open it in the browser when open=true.',
    { project_id: z.string().optional(), open: z.boolean().default(false) },
    async ({ project_id, open }) => {
      const base = await context.editorUrl()
      if (!base) throw new Error('The visual editor is not available in this process')
      const url = project_id ? `${base}/?project=${encodeURIComponent(project_id)}` : base
      if (open) openBrowser(url)
      return { url, opened: open }
    })
  return server
}
