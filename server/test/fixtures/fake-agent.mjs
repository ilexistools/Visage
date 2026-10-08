// A scripted stand-in for an agent harness, used to test the conformance kit itself.
// Usage: node fake-agent.mjs <skill path> <input file> <honest|no-runner|wrong-canary>
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [skill, inputFile, mode] = process.argv.slice(2)
if (mode === 'no-runner') {
  console.log('The workflow completed successfully.')
  process.exit(0)
}
const flow = join(dirname(skill), 'scripts', 'flow.mjs')
const input = JSON.parse(readFileSync(inputFile, 'utf8'))
let step = JSON.parse(execFileSync('node', [flow, 'start', '--input-file', inputFile], { encoding: 'utf8' }))
while (step.status === 'awaiting_output') {
  const text = readFileSync(step.step_file, 'utf8')
  let canary = /"canary": "([^"]+)"/.exec(text)[1]
  if (mode === 'wrong-canary' && step.node === 'classify') canary = 'made-up'
  const output = {
    intake: () => ({ route: input.route }),
    classify: () => ({ result: input.route, reason: 'from input' }),
    check: () => ({ result: step.previous_outputs.fix ? true : input.first_check, reason: 'rule' }),
    fix: () => ({ fixed: true }),
    strict: () => ({ result: step.attempt === 1 ? 'not-a-boolean' : true, reason: 'rule' }),
    grade: () => ({ result: input.score, reason: 'from input' }),
  }[step.node]()
  writeFileSync(step.output_file, JSON.stringify({ ...output, canary }))
  step = JSON.parse(execSync(step.submit, { encoding: 'utf8' }))
}
console.log(`Run ${step.status}`)
