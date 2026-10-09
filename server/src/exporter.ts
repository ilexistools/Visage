/** Export a Visage workflow as a plugin that Claude Code and Codex can run without Visage. */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import { DEFAULT_MAX_STEPS, type Workflow, type WorkflowNode } from './engine.ts'
import { assetPath } from './assets.ts'
import { workflowToMermaid } from './mermaid.ts'
import { badRequest, findProject, isInside, readJson, workflowPath } from './store.ts'
import { validateWorkflow } from './workflow.ts'

const MARKER = '.visage-export'
const SKIP_DIRS = new Set(['runs', 'dist', '.visage', 'node_modules', '__pycache__', '.git'])
const PORTABLE_KEYS = ['label', 'description', 'terminal', 'next', 'evaluation', 'max_attempts', 'on_fail', 'postcondition'] as const

type PortableNode = Pick<WorkflowNode, typeof PORTABLE_KEYS[number]> & { step?: string }
type Portable = { plugin: string; workflow: NonNullable<Workflow['workflow']>; start: string; max_steps: number; shared_references?: string[]; nodes: Record<string, PortableNode> }

export const slug = (value: string) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'workflow'

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)+/, '')

/** Copy a node's Skill folder, renaming SKILL.md to STEP.md so harnesses do not auto-discover it. */
function copyStep(skillFile: string, project: string, target: string): void {
  mkdirSync(target, { recursive: true })
  const folder = dirname(skillFile)
  if (resolve(folder) !== resolve(project)) {
    const projectRoot = realpathSync(project)
    cpSync(folder, target, {
      recursive: true,
      // Links are copied as the files they point to, and only when those stay inside the project.
      dereference: true,
      filter: source => {
        const rel = relative(folder, source)
        if (source === skillFile || (rel && SKIP_DIRS.has(rel.split(sep)[0]))) return false
        if (!lstatSync(source).isSymbolicLink()) return true
        try { return isInside(projectRoot, realpathSync(source)) } catch { return false }
      },
    })
  }
  writeFileSync(join(target, 'STEP.md'), stripFrontmatter(readFileSync(skillFile, 'utf8')))
}

function portableWorkflow(workflow: Workflow, name: string): Portable {
  const nodes: Record<string, PortableNode> = {}
  for (const [id, node] of Object.entries(workflow.nodes)) {
    const keep: PortableNode = {}
    for (const key of PORTABLE_KEYS) if (node[key] !== undefined) (keep as Record<string, unknown>)[key] = node[key]
    // Connection points are editor layout only.
    if (keep.next) keep.next = keep.next.map(({ goto, when, label }) => ({ goto, ...(when ? { when } : {}), ...(label ? { label } : {}) }))
    if (!node.terminal) keep.step = `nodes/${id}/STEP.md`
    nodes[id] = keep
  }
  const shared = (workflow.shared_references ?? []).map(sharedPath)
  return { plugin: name, workflow: workflow.workflow ?? {}, start: workflow.start, max_steps: workflow.max_steps ?? DEFAULT_MAX_STEPS, ...(shared.length ? { shared_references: shared } : {}), nodes }
}

/** Where a shared reference lives inside the exported Skill. */
const sharedPath = (path: string) => `shared/${path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')}`

/** Nodes in breadth-first order from the start node, then any unreachable ones. */
function ordered(portable: Portable): string[] {
  const order: string[] = []
  const queue = [portable.start]
  while (queue.length) {
    const id = queue.shift()!
    if (order.includes(id)) continue
    order.push(id)
    const node = portable.nodes[id]
    queue.push(...(node.next ?? []).map(transition => transition.goto))
    if (node.on_fail) queue.push(node.on_fail)
  }
  return [...order, ...Object.keys(portable.nodes).filter(id => !order.includes(id))]
}

const cell = (text: string) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
/** Inline code that stays intact when the text itself contains backticks. */
const code = (text: string) => text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``

function orchestrator(portable: Portable, description: string): string {
  const title = portable.workflow.name || portable.plugin
  const rows = ordered(portable).map(id => {
    const node = portable.nodes[id]
    const kind = node.terminal ? 'final' : id === portable.start ? 'start' : 'step'
    const evaluation = node.evaluation
    const gate = [
      evaluation?.type === 'choice' ? `choice: ${(evaluation.options ?? []).join(' / ')}` : evaluation?.type === 'score' ? 'score 0–1' : evaluation?.type ?? '',
      evaluation && (node.max_attempts ?? 1) > 1 ? `up to ${node.max_attempts} attempts` : '',
    ].filter(Boolean).join(', ') || '—'
    const next = node.terminal ? (node.postcondition ? `postcondition: ${code(node.postcondition.command)}` : '—') : [
      ...(node.next ?? []).map(t => `\`${t.goto}\`${t.when ? ` when ${code(t.when)}` : ''}`),
      ...(node.on_fail ? [`\`${node.on_fail}\` if evaluation fails`] : []),
    ].join('; ') || '—'
    return `| \`${id}\` | ${kind} | ${cell(node.description || node.label || id)} | ${cell(gate)} | ${cell(next)} |`
  })
  return `---
name: ${portable.plugin}
description: ${JSON.stringify(description)}
---
# ${title}

This Skill runs a fixed state-machine workflow. A runner script decides which step comes next and evaluates every step output before the workflow can advance. Never skip, reorder or merge steps, and never invent a step that the runner did not give you.

## Protocol

All commands below use \`scripts/flow.mjs\`, located in the same folder as this SKILL.md. Run them with \`node\` (version 20 or later) from the user's working directory.

1. **Start** a run with the user's request as input:
   \`node <this-skill-folder>/scripts/flow.mjs start --input '<JSON or text with the user request>'\`
   (use \`--input-file path.json\` for large inputs; if the user names the run, add \`--run <name>\` using letters, digits, \`-\` and \`_\`).
2. The runner prints JSON with \`status: "awaiting_output"\` and the current step: \`node\`, \`step_file\`, \`resources_dir\`, \`input\`, \`previous_outputs\`, \`feedback\`, \`output_contract\`, \`artifact_dir\`, \`output_file\` and the exact \`submit\` command.
3. **Execute the step**: read \`step_file\` and follow it exactly, using \`input\` and \`previous_outputs\` as context and files in \`resources_dir\` as references. When the reply lists \`shared_files\`, read them too: they fix the names, paths and interfaces every step must use, and they win over anything a step invents. Save any files you produce in \`artifact_dir\`; later steps find them there.
4. **Submit**: write one JSON object to \`output_file\` and run the \`submit\` command exactly as printed. When \`output_contract\` is present, the object must contain \`result\` answering its \`question\` (\`true\`/\`false\` for a predicate, exactly one of \`options\` for a choice, a number from 0 to 1 for a score) and a short \`reason\`. Files you produce go in \`artifact_dir\`; the runner uses only \`result\` to choose the next step.
5. Read the runner's reply:
   - \`decision: "next"\` with \`status: "awaiting_output"\` → go to step 3 for the new \`node\`.
   - \`decision: "retry"\` → the output was rejected; fix every item in \`errors\`/\`feedback\` and resubmit the same step.
   - \`status: "completed"\` → report to the user what the run produced: \`final_output\` (the last step's result and reason), the files in \`artifact_dir\` and, when present, the \`postcondition\` that was checked. \`final_state\` only names the end state; never present it as proof that the work is good.
   - \`status: "failed"\` → stop and report \`error\` to the user (with \`postcondition.output\` when a postcondition failed).
6. If you lose track of the run, \`node <this-skill-folder>/scripts/flow.mjs next\` prints the current step again; \`status\` shows progress.

Keep going until the run is \`completed\` or \`failed\`. Ask the user only when a step's instructions require information that is not available.

## Steps

| Node | Kind | Purpose | Result | Next |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`
}

function zipFolder(root: string, prefix: string): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name !== MARKER) files[`${prefix}/${relative(root, path).split(sep).join('/')}`] = readFileSync(path)
    }
  }
  walk(root)
  return zipSync(files, { level: 6 })
}

export function exportPlugin(projectId: string, outputDir?: string | null, makeZip = true) {
  const project = findProject(projectId)
  if (!project) throw badRequest(`Project not found: ${projectId}`)
  const root_path = project.root_path
  const { workflow, warnings } = validateWorkflow(readFileSync(workflowPath(projectId), 'utf8'), root_path, true)
  const runner = assetPath('flow.mjs')
  if (!runner) throw badRequest('Runner bundle not found; build the server first (npm run build)')
  const meta = workflow.workflow ?? {}
  const metadata = readJson<{ name?: string }>(join(root_path, 'project.json'), {})
  const name = slug(meta.id || projectId)
  const version = String(meta.version || '0.1.0')
  // The version names the zip file, so it must not carry path separators.
  const fileVersion = version.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || '0'
  const title = meta.name || metadata.name || name
  const steps = Object.entries(workflow.nodes).filter(([, node]) => !node.terminal).map(([id, node]) => node.label || id)
  const description = meta.description || `Run the ${title} workflow: a state machine of ${steps.length} evaluated step(s) (${steps.join(', ')}). Use when the user asks to run ${title}.`

  const base = outputDir ? resolve(outputDir.replace(/^~(?=$|[\\/])/, homedir())) : join(root_path, 'dist')
  const root = join(base, name)
  if (existsSync(root)) {
    if (!existsSync(join(root, MARKER))) throw badRequest(`Refusing to overwrite ${root}: it was not created by a Visage export`)
    rmSync(root, { recursive: true, force: true })
  }
  const skill = join(root, 'skills', name)
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(root, MARKER), 'Generated by Visage. This folder is replaced on every export.\n')

  const portable = portableWorkflow(workflow, name)
  for (const path of workflow.shared_references ?? []) {
    const target = join(skill, sharedPath(path))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root_path, path), target, { dereference: true })
  }
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (!node.terminal) copyStep(join(root_path, node.skill!.path!), root_path, join(skill, 'nodes', id))
  }
  writeFileSync(join(skill, 'workflow.json'), JSON.stringify(portable, null, 2) + '\n')
  cpSync(runner, join(skill, 'scripts', 'flow.mjs'))
  writeFileSync(join(skill, 'SKILL.md'), orchestrator(portable, description))
  mkdirSync(join(skill, 'agents'))
  writeFileSync(join(skill, 'agents', 'openai.yaml'), [
    'interface:',
    `  display_name: ${JSON.stringify(title)}`,
    `  short_description: ${JSON.stringify(description.slice(0, 120))}`,
    `  default_prompt: ${JSON.stringify(`Use $${name} to run this workflow on my request.`)}`,
    '',
  ].join('\n'))

  const author = { name: meta.author || 'Visage' }
  const manifest = { name, version, description, author, keywords: ['workflow', 'state-machine', 'visage'] }
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  mkdirSync(join(root, '.codex-plugin'))
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    ...manifest, skills: './skills/',
    interface: {
      displayName: title, shortDescription: description.slice(0, 120), longDescription: description,
      developerName: author.name, category: 'Productivity', capabilities: ['Write'], defaultPrompt: [`Run ${title} on this request.`],
    },
  }, null, 2) + '\n')
  writeFileSync(join(root, 'README.md'), `# ${title}

${description}

Generated by Visage from project \`${projectId}\` (workflow version ${version}).

## Flow

\`\`\`mermaid
${workflowToMermaid(workflow)}\`\`\`

## Install

- **Claude Code**: \`claude --plugin-dir ${root}\` for a session, or add this folder to a plugin marketplace.
- **Codex**: add this folder as a local plugin (it contains \`.codex-plugin/plugin.json\`), or copy \`skills/${name}\` to \`~/.codex/skills/\`.
- **Any other agent**: give it \`skills/${name}/SKILL.md\`; the runner needs only Node.js 20+.

## Run state

Runs are stored in \`.visage/runs/${name}/\` under the working directory (override with \`--state-dir\` or \`VISAGE_STATE_DIR\`).
`)
  const result: { plugin: string; version: string; path: string; warnings: string[]; zip?: string } = { plugin: name, version, path: root, warnings }
  if (makeZip) {
    const archive = join(base, `${name}-${fileVersion}.zip`)
    writeFileSync(archive, zipFolder(root, name))
    result.zip = archive
  }
  return result
}
