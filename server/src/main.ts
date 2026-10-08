#!/usr/bin/env node
/**
 * Visage: one process serving the visual editor, the REST API and MCP.
 *
 *   node visage.js                 editor + API + MCP over HTTP (/mcp)
 *   node visage.js --stdio         MCP over stdio for a harness; also serves the editor
 *   options: --port N (default 4317 or VISAGE_PORT), --open, --no-ui
 */
import type { Server } from 'node:http'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { assetPath } from './assets.ts'
import { createHttpServer } from './http.ts'
import { createMcpServer, openBrowser } from './mcp.ts'
import { dataDir } from './store.ts'
import { VERSION } from './version.ts'

const HOST = '127.0.0.1'
const PORT_TRIES = 10

const { values } = parseArgs({
  options: {
    stdio: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.VISAGE_PORT ?? '4317' },
    open: { type: 'boolean', default: false },
    'no-ui': { type: 'boolean', default: false },
  },
})
// In stdio mode stdout carries the MCP protocol, so every log goes to stderr.
const log = (...args: unknown[]) => console.error('[visage]', ...args)
const basePort = Number(values.port)

let localServer: Server | null = null
let editorBase: string | null = null

async function isVisage(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    return (await response.json())?.app === 'visage'
  } catch {
    return false
  }
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    }
    const onListening = () => { server.off('error', onError); resolve(true) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

/** Serve the editor on the first free port, or reuse a Visage instance that already serves it. */
async function ensureEditor(): Promise<string | null> {
  if (localServer) return editorBase
  if (editorBase && await isVisage(Number(new URL(editorBase).port))) return editorBase
  editorBase = null
  for (let port = basePort; port < basePort + PORT_TRIES; port++) {
    const server = createHttpServer({ uiDir: assetPath('ui'), editorUrl: ensureEditor })
    if (await listen(server, port)) {
      localServer = server
      editorBase = `http://${HOST}:${port}`
      log(`editor and API on ${editorBase} (data: ${dataDir()})`)
      return editorBase
    }
    if (await isVisage(port)) {
      editorBase = `http://${HOST}:${port}`
      log(`reusing the Visage editor already running on ${editorBase}`)
      return editorBase
    }
  }
  log(`no free port between ${basePort} and ${basePort + PORT_TRIES - 1}`)
  return null
}

async function main(): Promise<void> {
  log(`Visage ${VERSION}`)
  const url = values['no-ui'] ? null : await ensureEditor()
  if (url && values.open) openBrowser(url)
  if (values.stdio) {
    const server = createMcpServer({ editorUrl: values['no-ui'] ? async () => null : ensureEditor })
    const transport = new StdioServerTransport()
    transport.onclose = () => process.exit(0)
    process.stdin.on('end', () => process.exit(0))
    await server.connect(transport)
    log('MCP server ready on stdio')
  } else if (!localServer) {
    if (url) log(`Visage is already running on ${url}`)
    process.exit(url ? 0 : 1)
  }
}

main().catch(error => {
  log(error)
  process.exit(1)
})
