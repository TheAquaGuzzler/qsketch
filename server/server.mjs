#!/usr/bin/env node
// qsketch helper for macOS and Linux (Node 18 or newer); server.ps1 is the
// Windows twin and the two speak the same protocol.
//
// Serves the screenshot editor on 127.0.0.1 and receives the annotated images.
// Talks to the Claude Code mod through stdout, one JSON object per line:
//   {"type":"ready","port":N,"url":"..."}    listening
//   {"type":"opened","browser":"chrome"}      an editor window was opened
//   {"type":"attached","id":...,"meta":{...}} an image was attached
//   {"type":"log","message":"..."}            something worth a debug line
//   {"type":"exit","reason":"idle"}           stopping on its own
//
// GET api/waiting lists the attached images the mod has not marked done;
// POST api/done {"ids":[...]} marks them sent or dropped.
//
// Every URL lives under a random token, so other local pages cannot reach it.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const token = required('token')
const editorDir = resolve(required('editor-dir'))
const storeDir = resolve(required('store-dir'))
const keepDays = Number(args['keep-days'] ?? 7)
const idleMinutes = Number(args['idle-minutes'] ?? 30)
const browser = ['auto', 'edge', 'chrome', 'default'].includes(args.browser) ? args.browser : 'auto'

const MAX_BODY = 64 * 1024 * 1024
const MAX_META = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const arg = list[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const next = list[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      i++
    }
  }
  return out
}

function required(name) {
  const value = args[name]
  if (typeof value !== 'string' || !value) {
    process.stderr.write(`missing --${name}\n`)
    process.exit(2)
  }
  return value
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function log(message) {
  emit({ type: 'log', message })
}

function removeOldFiles() {
  if (!(keepDays > 0)) return
  const limit = Date.now() - keepDays * 24 * 60 * 60 * 1000
  for (const name of readdirSync(storeDir)) {
    if (!name.startsWith('annotation-')) continue
    const path = join(storeDir, name)
    try {
      const stat = statSync(path)
      if (stat.isFile() && stat.mtimeMs < limit) unlinkSync(path)
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

// Detached and unreferenced: a browser this starts outlives the helper.
function launch(command, list) {
  return new Promise(done => {
    try {
      const child = spawn(command, list, { detached: true, stdio: 'ignore' })
      child.once('error', () => done(false))
      child.once('spawn', () => {
        child.unref()
        done(true)
      })
    } catch {
      done(false)
    }
  })
}

const APP_WINDOW = url => [`--app=${url}`, '--window-size=1400,900']

async function openEditor(url) {
  const wantsEdge = browser === 'auto' || browser === 'edge'
  const wantsChrome = browser === 'auto' || browser === 'chrome'
  if (process.platform === 'darwin') {
    const apps = [
      wantsChrome && ['chrome', '/Applications/Google Chrome.app', 'Google Chrome'],
      wantsEdge && ['edge', '/Applications/Microsoft Edge.app', 'Microsoft Edge'],
    ].filter(Boolean)
    for (const [name, path, app] of apps) {
      if (existsSync(path) && (await launch('open', ['-na', app, '--args', ...APP_WINDOW(url)]))) return name
    }
    await launch('open', [url])
    return 'default'
  }
  if (process.platform === 'win32') {
    const apps = [wantsEdge && ['edge', 'msedge'], wantsChrome && ['chrome', 'chrome']].filter(Boolean)
    for (const [name, exe] of apps) {
      if (await launch('cmd.exe', ['/d', '/c', 'start', '""', exe, ...APP_WINDOW(url)])) return name
    }
    await launch('explorer.exe', [url])
    return 'default'
  }
  const apps = [
    wantsChrome && ['chrome', 'google-chrome'],
    wantsChrome && ['chrome', 'chromium'],
    wantsChrome && ['chrome', 'chromium-browser'],
    wantsEdge && ['edge', 'microsoft-edge'],
  ].filter(Boolean)
  const paths = (process.env.PATH || '').split(':')
  for (const [name, command] of apps) {
    if (paths.some(dir => existsSync(join(dir, command))) && (await launch(command, APP_WINDOW(url)))) return name
  }
  await launch('xdg-open', [url])
  return 'default'
}

function openStoreFolder() {
  if (process.platform === 'darwin') return launch('open', [storeDir])
  if (process.platform === 'win32') return launch('explorer.exe', [storeDir])
  return launch('xdg-open', [storeDir])
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...headers,
  })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value)))
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

function stamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// The body is one line of JSON metadata, a newline, then the PNG's bytes.
function saveAttachment(body) {
  const newline = body.indexOf(10)
  if (newline < 2 || newline > MAX_META) throw new Error('missing metadata')
  const meta = body.subarray(0, newline).toString('utf8').trim()
  if (!(meta.startsWith('{') && meta.endsWith('}'))) throw new Error('metadata is not a JSON object')
  const parsed = JSON.parse(meta)
  const png = body.subarray(newline + 1)
  if (png.length < 64 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('image is not a PNG')
  const id = `annotation-${stamp()}-${randomBytes(2).toString('hex')}`
  const pngPath = join(storeDir, `${id}.png`)
  const jsonPath = join(storeDir, `${id}.json`)
  writeFileSync(pngPath, png, { flag: 'wx' })
  writeFileSync(jsonPath, meta, 'utf8')
  const item = { id, png: pngPath, json: jsonPath, meta: parsed }
  attachments.push({ item, done: false })
  emit({ type: 'attached', ...item })
  return { ok: true, id, path: pngPath }
}

// What this helper saved and the mod has not yet sent or dropped: the mod asks
// for it when a prompt goes out, in case a stdout report never reached it.
const attachments = []

function markDone(body) {
  const { ids } = JSON.parse(body.toString('utf8'))
  if (!Array.isArray(ids)) throw new Error('ids must be a list')
  for (const attachment of attachments) if (ids.includes(attachment.item.id)) attachment.done = true
  return { ok: true }
}

function serveStatic(res, path) {
  const relative = path === '' ? 'index.html' : path
  if (!/^[A-Za-z0-9_\-./]+$/.test(relative) || relative.includes('..')) return sendJson(res, 404, { ok: false, error: 'not found' })
  const file = resolve(editorDir, relative)
  if (!file.startsWith(editorDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }
  const extension = extname(file).toLowerCase()
  const headers = extension === '.html' ? { 'Content-Security-Policy': CSP } : {}
  send(res, 200, CONTENT_TYPES[extension] || 'application/octet-stream', readFileSync(file), headers)
}

let port = 0
let url = ''
let lastActivity = Date.now()

async function handle(req, res) {
  lastActivity = Date.now()
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, { ok: false, error: 'wrong host' })
  const target = (req.url || '/').split('?')[0]
  if (target === `/${token}`) return send(res, 301, 'text/plain; charset=utf-8', Buffer.from('Moved'), { Location: `/${token}/` })
  const prefix = `/${token}/`
  if (!target.startsWith(prefix)) return sendJson(res, 404, { ok: false, error: 'not found' })
  const path = target.slice(prefix.length)

  if (path.startsWith('api/')) {
    const origin = req.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return sendJson(res, 403, { ok: false, error: 'wrong origin' })
    }
    if (path === 'api/ping') return sendJson(res, 200, { ok: true })
    if (path === 'api/waiting') return sendJson(res, 200, { ok: true, items: attachments.filter(a => !a.done).map(a => a.item) })
    const posts = ['api/attach', 'api/done', 'api/open', 'api/reveal']
    if (req.method !== 'POST') return sendJson(res, posts.includes(path) ? 405 : 404, { ok: false })
    if (path === 'api/attach') return sendJson(res, 200, saveAttachment(await readBody(req)))
    if (path === 'api/done') return sendJson(res, 200, markDone(await readBody(req)))
    if (path === 'api/open') {
      emit({ type: 'opened', browser: await openEditor(url) })
      return sendJson(res, 200, { ok: true })
    }
    if (path === 'api/reveal') {
      await openStoreFolder()
      return sendJson(res, 200, { ok: true })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false })
  serveStatic(res, path)
}

mkdirSync(storeDir, { recursive: true })
removeOldFiles()

const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    log(`request failed: ${error.message}`)
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: error.message })
    else res.destroy()
  })
})

server.listen(0, '127.0.0.1', async () => {
  port = server.address().port
  url = `http://127.0.0.1:${port}/${token}/`
  emit({ type: 'ready', port, url, store: storeDir })
  if (args.open) emit({ type: 'opened', browser: await openEditor(url) })
})

if (idleMinutes > 0) {
  setInterval(() => {
    if (Date.now() - lastActivity >= idleMinutes * 60 * 1000) {
      emit({ type: 'exit', reason: 'idle' })
      process.exit(0)
    }
  }, 30 * 1000).unref()
}

// The mod is gone once nobody reads what this writes.
process.stdout.on('error', () => process.exit(0))
