import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp.ts'

const docs = join(import.meta.dirname, '..', '..', 'docs', 'harness')
const files = ['README.md', 'SKILL.md', ...readdirSync(join(docs, 'references')).map(name => `references/${name}`)]

test('every MCP tool is documented, and every documented tool exists', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createMcpServer({ editorUrl: async () => null }).connect(serverSide)
  const client = new Client({ name: 'docs', version: '1' })
  await client.connect(clientSide)
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort()
  const reference = readFileSync(join(docs, 'references/mcp-tools.md'), 'utf8')
  const documented = [...reference.matchAll(/^### `([a-z_]+)`$/gm)].map(match => match[1]).sort()
  assert.deepEqual(documented, tools)
  assert.match(reference, new RegExp(`exposes ${tools.length} tools`))
  assert.match(readFileSync(join(docs, 'README.md'), 'utf8'), new RegExp(`${tools.length} tools`))
  await client.close()
})

test('links between the harness documents resolve', () => {
  for (const file of files) {
    const text = readFileSync(join(docs, file), 'utf8')
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
      assert.ok(existsSync(join(docs, dirname(file), target)), `${file} links to missing ${target}`)
    }
  }
})

test('the visage Skill has the frontmatter harnesses need', () => {
  const skill = readFileSync(join(docs, 'SKILL.md'), 'utf8')
  const frontmatter = /^---\nname: visage\ndescription: "([^"]+)"\n---\n/.exec(skill)
  assert.ok(frontmatter, 'SKILL.md starts with name and description')
  assert.ok(frontmatter[1].length <= 1024, 'the description fits harness limits')
})
