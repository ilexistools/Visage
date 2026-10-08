import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, sep } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { exportPlugin } from './exporter.ts'
import { createMcpServer } from './mcp.ts'
import * as projects from './projects.ts'
import { badRequest, HttpError, inside, notFound } from './store.ts'
import { VERSION } from './version.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const MAX_BODY = 40_000_000
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

type Handler = (request: IncomingMessage, params: string[], body: () => Promise<any>) => unknown | Promise<unknown>
type Route = [method: string, pattern: RegExp, handler: Handler]

function send(response: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers })
  response.end(payload)
}

class Raw {
  constructor(public body: string | Uint8Array, public type: string, public headers: Record<string, string> = {}) {}
}

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(badRequest('Request body is too large')); request.destroy() }
      else chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve(undefined)
      try { resolve(JSON.parse(text)) } catch { reject(badRequest('Invalid JSON body')) }
    })
    request.on('error', reject)
  })
}

/** Reject requests whose Host or Origin is not local, which blocks DNS-rebinding attacks from web pages. */
function isLocalRequest(request: IncomingMessage): boolean {
  const hostname = (value: string) => { try { return new URL(`http://${value}`).hostname } catch { return '' } }
  if (!LOCAL_HOSTS.has(hostname(request.headers.host ?? ''))) return false
  const origin = request.headers.origin
  if (origin && origin !== 'null') {
    try { return LOCAL_HOSTS.has(new URL(origin).hostname) } catch { return false }
  }
  return true
}

function folderPicker(): { path: string } {
  const prompt = 'Choose a location for the Visage project'
  let result
  if (process.platform === 'darwin') {
    result = spawnSync('osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt}")`], { encoding: 'utf8', timeout: 180_000 })
  } else if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}"
    result = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', timeout: 180_000 })
  } else {
    result = spawnSync('zenity', ['--file-selection', '--directory', `--title=${prompt}`], { encoding: 'utf8', timeout: 180_000 })
    if (result.error) result = spawnSync('kdialog', ['--getexistingdirectory', '.', '--title', prompt], { encoding: 'utf8', timeout: 180_000 })
    if (result.error) throw badRequest('Install zenity or kdialog to use the folder picker, or enter a folder path manually.')
  }
  if (result.error) throw badRequest(`Could not open the folder picker: ${result.error.message}`)
  return { path: result.status === 0 ? result.stdout.trim().replace(/\/$/, '') : '' }
}

const id = String.raw`([^/]+)`
const routes: Route[] = [
  ['GET', /^\/api\/health$/, () => ({ status: 'ok', app: 'visage', version: VERSION })],
  ['GET', /^\/api\/projects$/, () => projects.listProjects()],
  ['POST', /^\/api\/projects$/, async (_, __, body) => projects.createProject(await body() ?? {})],
  ['PUT', new RegExp(`^/api/projects/${id}$`), async (_, [pid], body) => projects.renameProject(pid, (await body())?.name)],
  ['DELETE', new RegExp(`^/api/projects/${id}$`), (_, [pid]) => projects.deleteProject(pid)],
  ['GET', /^\/api\/folder-picker$/, () => folderPicker()],
  ['GET', new RegExp(`^/api/projects/${id}/workflow$`), (_, [pid]) => projects.getWorkflow(pid)],
  ['PUT', new RegExp(`^/api/projects/${id}/workflow$`), async (_, [pid], body) => projects.putWorkflow(pid, (await body())?.source ?? '')],
  ['GET', new RegExp(`^/api/projects/${id}/validate$`), (_, [pid]) => projects.validateProject(pid)],
  ['POST', new RegExp(`^/api/projects/${id}/export$`), async (_, [pid], body) => exportPlugin(pid, (await body())?.output_dir)],
  ['GET', new RegExp(`^/api/projects/${id}/export\\.zip$`), (_, [pid]) => {
    const result = exportPlugin(pid)
    return new Raw(readFileSync(result.zip!), 'application/zip', { 'Content-Disposition': `attachment; filename="${basename(result.zip!)}"` })
  }],
  ['GET', new RegExp(`^/api/projects/${id}/files$`), (_, [pid]) => projects.listFiles(pid)],
  ['GET', new RegExp(`^/api/projects/${id}/files/(.+)$`), (_, [pid, path]) => new Raw(projects.readFile(pid, path), 'text/plain; charset=utf-8')],
  ['PUT', new RegExp(`^/api/projects/${id}/files/(.+)$`), async (_, [pid, path], body) => {
    const { content, encoding } = await body() ?? {}
    if (typeof content !== 'string') throw badRequest('content must be a string')
    return projects.writeFile(pid, path, content, encoding === 'base64' ? 'base64' : 'utf-8')
  }],
]

async function handleMcp(request: IncomingMessage, response: ServerResponse, editorUrl: () => Promise<string | null>): Promise<void> {
  // Stateless Streamable HTTP: one server and transport per request.
  const server = createMcpServer({ editorUrl })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  response.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(request, response, request.method === 'POST' ? await readBody(request) : undefined)
}

function serveUi(uiDir: string | null, pathname: string, response: ServerResponse): void {
  if (!uiDir) return send(response, 404, 'Visual editor not built. Run `npm run build` in server/.', 'text/plain; charset=utf-8')
  let file = join(uiDir, 'index.html')
  try {
    const candidate = inside(uiDir, decodeURIComponent(pathname.slice(1)))
    if (pathname !== '/' && existsSync(candidate) && statSync(candidate).isFile()) file = candidate
  } catch { /* fall back to index.html */ }
  const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store'
  response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache })
  response.end(readFileSync(file))
}

export function createHttpServer(options: { uiDir: string | null; editorUrl: () => Promise<string | null> }): Server {
  return createServer(async (request, response) => {
    try {
      if (!isLocalRequest(request)) return send(response, 403, { detail: 'Visage only accepts local requests' })
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/mcp') return await handleMcp(request, response, options.editorUrl)
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { detail: 'Method not allowed' })
        return serveUi(options.uiDir, url.pathname, response)
      }
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname)
        if (!match) continue
        if (method !== request.method) continue
        const params = match.slice(1).map(decodeURIComponent)
        const result = await handler(request, params, () => readBody(request))
        if (result instanceof Raw) return send(response, 200, result.body, result.type, result.headers)
        return send(response, 200, result)
      }
      throw notFound('Not Found')
    } catch (error) {
      if (response.headersSent) return void response.end()
      const status = error instanceof HttpError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500
      if (status === 500) console.error(error)
      send(response, status, { detail: (error as Error).message })
    }
  })
}
