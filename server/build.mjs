// Build Visage into self-contained files.
//   node build.mjs            runner + server bundle + editor UI in build/
//   node build.mjs --runner   only the exported-workflow runner (used by tests)
//   node build.mjs --plugin   everything above, assembled as a Claude Code / Codex plugin in dist/
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { zipSync } from 'fflate'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, 'build')
const frontend = join(root, '..', 'frontend')
const args = new Set(process.argv.slice(2))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const common = { bundle: true, platform: 'node', target: 'node20', format: 'esm', legalComments: 'none', logLevel: 'warning' }

async function buildRunner() {
  await build({ ...common, entryPoints: [join(root, 'src/runner/flow.ts')], outfile: join(out, 'flow.mjs'), banner: { js: '#!/usr/bin/env node' } })
}

async function buildServer() {
  writeFileSync(join(root, 'src/version.ts'), `export const VERSION = '${version}'\n`)
  await build({
    ...common,
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(out, 'visage.js'),
    // Some bundled dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    minify: true,
  })
}

function buildUi() {
  execSync('npm run build', { cwd: frontend, stdio: 'inherit' })
  rmSync(join(out, 'ui'), { recursive: true, force: true })
  cpSync(join(frontend, 'dist'), join(out, 'ui'), { recursive: true })
}

const PLUGIN_SKILL = `---
name: visage
description: "Design, edit and export state-machine workflows of agent Skills with Visage: each node is a Skill, transitions decide the order, and each step output is evaluated before the next. Use when the user wants to create or change a Skill workflow, open the Visage visual editor, or export a workflow as a Claude Code / Codex plugin."
---
# Visage

Visage stores workflows as projects (a folder with \`workflow.yaml\` and one \`skills/<node>/SKILL.md\` per step). Use the \`visage\` MCP tools to work on them; the same changes appear live in the visual editor.

## Building a workflow

1. \`create_project\` (or \`list_projects\` to reuse one).
2. For each step, \`upsert_node\` with a clear \`label\`, \`description\` and \`skill_markdown\` (the full instructions for that step). The first node becomes the start node.
3. When the next step depends on this one, give it an \`evaluation\`: \`predicate\` (true/false, e.g. "Does it pass the tests?"), \`choice\` (one of \`options\`, e.g. approved / changes / rejected) or \`score\` (0 to 1). Write the \`question\` the step answers. Steps only produce files? Leave the evaluation out. Use \`max_attempts\` and \`on_fail\` for invalid results.
4. \`upsert_node\` with \`terminal: true\` for each final state, then \`set_transitions\` for every step. Order matters: the first transition whose \`when\` matches wins; leave \`when\` empty for the default.
5. \`validate_project\` and fix every error.
6. \`export_plugin\` to produce the plugin folder and zip.

## The visual editor

Call \`open_editor\` (with \`project_id\` and \`open: true\` to launch the browser) and give the user the returned URL. Tell the user that edits made in the editor and through these tools affect the same files.

## Routing on the result

Every evaluated step returns \`{"result": ..., "reason": "..."}\`. Route with \`set_transitions\`: predicate \`output.result == true\` / \`output.result == false\`; choice \`output.result == "approved"\`; score \`output.result >= 0.8\` (also \`>\`, \`<\`, \`<=\`). Leave \`when\` empty on the last arc for "otherwise". \`validate_project\` warns about results that have no arc.
`

function assemblePlugin() {
  const dist = join(root, 'dist')
  const plugin = join(dist, 'visage')
  rmSync(plugin, { recursive: true, force: true })
  mkdirSync(join(plugin, 'server'), { recursive: true })
  cpSync(join(out, 'visage.js'), join(plugin, 'server', 'visage.js'))
  cpSync(join(out, 'flow.mjs'), join(plugin, 'server', 'flow.mjs'))
  cpSync(join(out, 'ui'), join(plugin, 'server', 'ui'), { recursive: true })
  mkdirSync(join(plugin, 'skills', 'visage'), { recursive: true })
  writeFileSync(join(plugin, 'skills', 'visage', 'SKILL.md'), PLUGIN_SKILL)
  const description = 'Visual editor and MCP server for state-machine workflows of agent Skills, exportable as Claude Code and Codex plugins.'
  const manifest = { name: 'visage', version, description, author: { name: 'Visage' }, keywords: ['workflow', 'state-machine', 'skills', 'mcp'] }
  const json = value => JSON.stringify(value, null, 2) + '\n'
  mkdirSync(join(plugin, '.claude-plugin'))
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), json(manifest))
  writeFileSync(join(plugin, '.mcp.json'), json({ mcpServers: { visage: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/visage.js', '--stdio'] } } }))
  mkdirSync(join(plugin, '.codex-plugin'))
  writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), json({
    ...manifest, skills: './skills/', mcpServers: './.codex-mcp.json',
    interface: {
      displayName: 'Visage', shortDescription: 'Design and export state-machine workflows of Skills', longDescription: description,
      developerName: 'Visage', category: 'Productivity', capabilities: ['Interactive', 'Write'],
      defaultPrompt: ['Open the Visage editor', 'Create a Visage workflow for this process'],
    },
  }))
  writeFileSync(join(plugin, '.codex-mcp.json'), json({ mcpServers: { visage: { command: 'node', args: ['./server/visage.js', '--stdio'], cwd: '.', startup_timeout_sec: 20 } } }))
  writeFileSync(join(plugin, 'README.md'), `# Visage ${version}\n\n${description}\n\nRequires Node.js 20+.\n\n- Claude Code: \`claude --plugin-dir ${plugin}\`\n- Codex: add this folder as a local plugin.\n- Standalone editor: \`node server/visage.js --open\` (http://127.0.0.1:4317).\n\nProjects are listed in \`~/.visage/projects.json\` (override with \`VISAGE_DATA_DIR\`).\n`)
  const files = {}
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[`visage/${relative(plugin, path).split(sep).join('/')}`] = readFileSync(path)
    }
  }
  walk(plugin)
  const archive = join(dist, `visage-${version}.zip`)
  writeFileSync(archive, zipSync(files, { level: 9 }))
  console.log(`Plugin: ${plugin}\nZip:    ${archive}`)
}

mkdirSync(out, { recursive: true })
await buildRunner()
if (!args.has('--runner')) {
  await buildServer()
  if (!existsSync(join(out, 'ui')) || !args.has('--skip-ui')) buildUi()
  if (args.has('--plugin')) assemblePlugin()
}
