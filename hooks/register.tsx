import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, PluginOptions, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { QsketchAttachment, QsketchNote, QsketchStatus } from '../types'

// The band button opens a Paint-style editor in its own window. The editor is
// a local web page served by a small helper process (server/), which saves
// each attached picture and reports it on stdout. The next prompt the person
// sends carries a note that tells the model to open the picture with Read.

type Engine = EngineInterface

type Options = {
  keepDays: number
  browser: 'auto' | 'edge' | 'chrome' | 'default'
  showButton: boolean
}

type Host = {
  windows: boolean
  home: string
  systemRoot: string
}

type Helper = {
  url: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  ready: Promise<string>
}

const pending = atom({ plugin: 'qsketch', key: 'pending' } as const, [])
const status = atom({ plugin: 'qsketch', key: 'status' } as const, { phase: 'idle', message: '' })
const lastSent = atom({ plugin: 'qsketch', key: 'sent' } as const, null)

const READY_TIMEOUT_MS = 30000
// Where a submitted prompt counts as the person's own words.
const PERSON_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
const MARK_WORDS: Record<string, [string, string]> = {
  marker: ['numbered marker', 'numbered markers'],
  arrow: ['arrow', 'arrows'],
  rect: ['box', 'boxes'],
  ellipse: ['ellipse', 'ellipses'],
  text: ['text label', 'text labels'],
  pen: ['freehand stroke', 'freehand strokes'],
  highlighter: ['highlight', 'highlights'],
}

let helper: Helper | undefined
// Made in this load's session.start, so the helper and its reports live on
// that hook's `$`, the home the API documents for work as long as the session.
let launch: ((options: Options) => Promise<string | undefined>) | undefined
let drop: ((ids?: readonly string[]) => Promise<number>) | undefined

// ---------------------------------------------------------------- options

function readOptions(options: PluginOptions): Options {
  const keepDays = Number(options.keepDays)
  const browser = String(options.browser ?? 'auto')
  return {
    keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? Math.floor(keepDays) : 7,
    browser: browser === 'edge' || browser === 'chrome' || browser === 'default' ? browser : 'auto',
    showButton: options.showButton !== false,
  }
}

// ---------------------------------------------------------------- paths

async function hostOf($: Engine): Promise<Host> {
  const systemRoot = await $.env.get('SystemRoot')
  const userProfile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  const windows = systemRoot !== undefined
  return {
    windows,
    home: (windows ? (userProfile ?? home) : (home ?? userProfile)) ?? '',
    systemRoot: systemRoot ?? 'C:\\Windows',
  }
}

function joinPath(host: Host, ...parts: string[]): string {
  const separator = host.windows ? '\\' : '/'
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(separator)
}

function storeDir(host: Host): string {
  return joinPath(host, host.home, '.claude', 'qsketch', 'attachments')
}

function comparable(host: Host, path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  return host.windows ? unified.toLowerCase() : unified
}

function isUnder(host: Host, path: string, folder: string): boolean {
  const child = comparable(host, path)
  if (child.split('/').includes('..')) return false
  return child.startsWith(comparable(host, folder).replace(/\/$/, '') + '/')
}

// Only the pictures and notes qsketch itself saved, wherever links lead.
async function isAttachmentFile($: Engine, path: string): Promise<boolean> {
  if (!/\.(png|json)$/i.test(path)) return false
  const host = await hostOf($)
  const store = storeDir(host)
  if (!isUnder(host, path, store)) return false
  const [file, folder] = await Promise.all([
    $.fs.stat(path, { resolve: true }).catch(() => undefined),
    $.fs.stat(store, { resolve: true }).catch(() => undefined),
  ])
  if (!file || file.kind !== 'file' || !file.realPath || !folder?.realPath) return false
  return isUnder(host, file.realPath, folder.realPath)
}

// ---------------------------------------------------------------- helper process

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function helperArgv(host: Host, root: string, token: string, store: string, options: Options): string[] {
  if (host.windows) {
    return [
      joinPath(host, host.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      joinPath(host, root, 'server', 'server.ps1'),
      '-Token',
      token,
      '-EditorDir',
      joinPath(host, root, 'editor'),
      '-StoreDir',
      store,
      '-KeepDays',
      String(options.keepDays),
      '-Browser',
      options.browser,
      '-Open',
    ]
  }
  return [
    'node',
    joinPath(host, root, 'server', 'server.mjs'),
    '--token',
    token,
    '--editor-dir',
    joinPath(host, root, 'editor'),
    '--store-dir',
    store,
    '--keep-days',
    String(options.keepDays),
    '--browser',
    options.browser,
    '--open',
  ]
}

async function setStatus($: Engine, phase: QsketchStatus['phase'], message = ''): Promise<void> {
  await update($, status, () => ({ phase, message }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

// The helper relays what the editor page sent: read it as data.
function toAttachment(host: Host, event: Record<string, unknown>): QsketchAttachment | undefined {
  const id = typeof event.id === 'string' && /^annotation-[\w-]{1,80}$/.test(event.id) ? event.id : undefined
  const png = typeof event.png === 'string' ? event.png : undefined
  if (!id || !png || !isUnder(host, png, storeDir(host))) return undefined
  const meta = isRecord(event.meta) ? event.meta : {}
  const notes: QsketchNote[] = Array.isArray(meta.notes)
    ? meta.notes
        .filter(isRecord)
        .map(note => ({ n: Math.floor(Number(note.n)), text: text(note.text, 2000) }))
        .filter(note => Number.isInteger(note.n) && note.n > 0 && note.n < 1000)
        .slice(0, 99)
    : []
  const marks: Record<string, number> = {}
  if (isRecord(meta.marks)) {
    for (const [kind, count] of Object.entries(meta.marks)) {
      if (kind in MARK_WORDS && Number.isInteger(count) && Number(count) > 0) marks[kind] = Number(count)
    }
  }
  const thumb =
    typeof meta.thumb === 'string' && meta.thumb.length < 120000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(meta.thumb)
      ? meta.thumb
      : ''
  const size = (value: unknown) => (Number.isInteger(value) && Number(value) > 0 ? Number(value) : 0)
  return { id, png, width: size(meta.width), height: size(meta.height), notes, comment: text(meta.comment, 4000), marks, thumb }
}

async function onHelperEvent($: Engine, host: Host, current: Helper, event: Record<string, unknown>, resolveReady: (url: string) => void) {
  switch (event.type) {
    case 'ready':
      if (typeof event.url === 'string') {
        current.url = event.url
        resolveReady(event.url)
      }
      return
    case 'opened':
      await setStatus($, 'idle')
      $.ui.toast(`The screenshot editor is open. Paste a screenshot there with ${host.windows ? 'Ctrl+V' : '⌘V'}.`, {
        timeoutMs: 6000,
      })
      return
    case 'attached': {
      const attachment = toAttachment(host, event)
      if (!attachment) {
        $.ui.log(`qsketch: ignored an attachment the helper reported: ${JSON.stringify(event).slice(0, 300)}`, { to: 'debug' })
        return
      }
      const list = await update($, pending, now => [...now.filter(a => a.id !== attachment.id), attachment])
      // A line in the conversation itself: the band may not be drawn (an empty
      // chat) and the desktop may not show toasts.
      $.ui.log(`${attachedLine(attachment, list.length)} It goes with your next message.`)
      return
    }
    case 'log':
    case 'error':
      $.ui.log(`qsketch helper: ${text(event.message, 500)}`, { to: 'debug' })
      return
  }
}

async function pump($: Engine, host: Host, current: Helper, settle: { resolve: (url: string) => void; reject: (error: Error) => void }) {
  let buffer = ''
  let errors = ''
  try {
    for await (const chunk of current.stream) {
      if (chunk.stream === 'stderr') {
        errors = (errors + chunk.text).slice(-2000)
        $.ui.log(`qsketch helper stderr: ${chunk.text.trim().slice(0, 500)}`, { to: 'debug' })
        continue
      }
      buffer += chunk.text
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch {
          $.ui.log(`qsketch helper: ${line.slice(0, 300)}`, { to: 'debug' })
          continue
        }
        if (isRecord(event)) await onHelperEvent($, host, current, event, settle.resolve)
      }
    }
  } catch (error) {
    $.ui.log(`qsketch helper failed: ${String(error).slice(0, 300)}`, { to: 'debug' })
  } finally {
    if (helper === current) helper = undefined
    const reason = errors.trim().split('\n').pop()?.trim() || 'the editor helper stopped'
    settle.reject(new Error(reason))
    if (!current.url) await setStatus($, 'error', reason).catch(() => undefined)
  }
}

function startHelper($: Engine, host: Host, options: Options): Helper {
  const token = randomToken()
  const argv = helperArgv(host, $.plugin.root, token, storeDir(host), options)
  let settle!: { resolve: (url: string) => void; reject: (error: Error) => void }
  const ready = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  ready.catch(() => undefined)
  const current: Helper = { url: '', stream: $.process.spawn({ argv }), ready }
  helper = current
  void pump($, host, current, settle)
  const timer = $.clock.after(READY_TIMEOUT_MS, () => {
    if (current.url) return
    settle.reject(new Error('the editor helper did not start in time'))
    void current.stream.return(undefined as never)
  })
  ready.then(() => timer.cancel(), () => timer.cancel())
  return current
}

// Opens an editor window, starting the helper when none runs. Resolves once
// the window is on its way: undefined, or why it could not open.
async function openEditor($: Engine, options: Options): Promise<string | undefined> {
  try {
    const host = await hostOf($)
    const current = helper
    if (current?.url) {
      const response = await $.http.fetch(`${current.url}api/open`, { method: 'POST' }).catch(() => undefined)
      if (response?.ok) return undefined
      // The helper is gone or stuck: start a fresh one below.
      void current.stream.return(undefined as never)
      if (helper === current) helper = undefined
    } else if (current) {
      // Starting already; it opens the window itself once it listens.
      await current.ready
      return undefined
    }
    await setStatus($, 'starting', 'Opening the editor...')
    await startHelper($, host, options).ready
    // Listening: the helper opens the window on its own from here.
    await setStatus($, 'idle')
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await setStatus($, 'error', `Could not open the editor: ${reason}`).catch(() => undefined)
    return reason
  }
}

// What the helper saved that its stdout report may never have delivered.
async function waitingOnHelper($: Engine, host: Host): Promise<QsketchAttachment[]> {
  const current = helper
  if (!current?.url) return []
  try {
    const response = await $.http.fetch(`${current.url}api/waiting`)
    const body: unknown = response.ok ? JSON.parse(response.text) : undefined
    if (!isRecord(body) || !Array.isArray(body.items)) return []
    return body.items.filter(isRecord).flatMap(item => toAttachment(host, item) ?? [])
  } catch {
    return []
  }
}

// Tells the helper these are sent or dropped, so they are not offered again.
async function doneOnHelper($: Engine, ids: readonly string[]): Promise<void> {
  const current = helper
  if (!current?.url || !ids.length) return
  await $.http.fetch(`${current.url}api/done`, { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => undefined)
}

async function dropPending($: Engine, ids?: readonly string[]): Promise<number> {
  const before = await read($, pending)
  const host = await hostOf($)
  const dropped = ids ?? [...new Set([...before.map(a => a.id), ...(await waitingOnHelper($, host)).map(a => a.id)])]
  await update($, pending, now => now.filter(a => !dropped.includes(a.id)))
  await doneOnHelper($, dropped)
  return dropped.length
}

async function openFolder($: Engine): Promise<string> {
  const host = await hostOf($)
  const store = storeDir(host)
  const current = helper
  if (current?.url) {
    const response = await $.http.fetch(`${current.url}api/reveal`, { method: 'POST' }).catch(() => undefined)
    if (response?.ok) return store
  }
  if (!(await $.fs.exists(store))) return store
  await $.process.run(host.windows ? ['explorer.exe', store] : ['open', store]).catch(() => undefined)
  return store
}

// ---------------------------------------------------------------- the model's note

function plural(count: number, words: [string, string]): string {
  return `${count} ${count === 1 ? words[0] : words[1]}`
}

function describeMarks(marks: Record<string, number>): string {
  return Object.entries(marks)
    .filter(([kind]) => kind in MARK_WORDS)
    .map(([kind, count]) => plural(count, MARK_WORDS[kind]!))
    .join(', ')
}

export function describeAttachments(list: readonly QsketchAttachment[]): string {
  const many = list.length > 1
  const lines = [
    `The user attached ${many ? `${list.length} annotated screenshots` : 'an annotated screenshot'} to this message with the qsketch plugin.`,
    `They drew on ${many ? 'them' : 'it'} to point at what they mean (arrows, boxes, highlights, labels, numbered markers).`,
    `Open ${many ? 'each image' : 'the image'} with the Read tool before you answer, and use the marks and notes to understand the request.`,
  ]
  list.forEach((a, i) => {
    lines.push('')
    const size = a.width && a.height ? ` (${a.width}x${a.height})` : ''
    lines.push(`${many ? `Screenshot ${i + 1}` : 'Screenshot'}: ${a.png}${size}`)
    const written = a.notes.filter(note => note.text)
    if (written.length) {
      lines.push('Numbered markers:')
      for (const note of written) lines.push(`  ${note.n}. ${note.text.replace(/\n/g, '\n     ')}`)
    }
    const silent = a.notes.filter(note => !note.text).map(note => note.n)
    if (silent.length) lines.push(`Markers without a note: ${silent.join(', ')}`)
    if (a.comment) lines.push(`Comment: ${a.comment.replace(/\n/g, '\n  ')}`)
    const marks = describeMarks(a.marks)
    if (marks) lines.push(`Marks: ${marks}`)
  })
  return `<annotated-screenshots>\n${lines.join('\n')}\n</annotated-screenshots>`
}

function attachedLine(a: QsketchAttachment, waiting: number): string {
  const written = a.notes.filter(note => note.text).length
  const what = waiting > 1 ? `Screenshot ${waiting} attached` : 'Screenshot attached'
  return `\u{1F4CE} ${what}${written ? ` (${plural(written, ['note', 'notes'])})` : ''}.`
}

// The line added under the person's own words, so the sent message itself
// shows that the pictures went with it.
export function sentLine(list: readonly QsketchAttachment[]): string {
  const notes = list.reduce((sum, a) => sum + a.notes.filter(note => note.text).length, 0)
  const what = list.length === 1 ? 'Annotated screenshot attached' : `${list.length} annotated screenshots attached`
  return `\u{1F4CE} ${what}${notes ? ` (${plural(notes, ['note', 'notes'])})` : ''}`
}

// ---------------------------------------------------------------- drawing

function thumbnailSvg(a: QsketchAttachment, height: number): { source: string; width: number } {
  const ratio = a.width && a.height ? a.width / a.height : 16 / 9
  const width = Math.max(28, Math.min(150, Math.round(height * ratio)))
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><clipPath id="r"><rect width="${width}" height="${height}" rx="5"/></clipPath></defs>` +
    `<rect width="${width}" height="${height}" rx="5" fill="#2a2a30"/>` +
    `<image href="${a.thumb}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/>` +
    `</svg>`
  return { source, width }
}

function summary(a: QsketchAttachment, index: number): string {
  const written = a.notes.filter(note => note.text).length
  return `#${index + 1}${written ? ` \u00b7 ${plural(written, ['note', 'notes'])}` : ''}`
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, rawOptions) => {
  const options = readOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'qsk',
      description: 'Mark up a screenshot and attach it to your next message',
      argumentHint: '[clear | folder]',
      immediate: true,
    })
    launch = options => openEditor($, options)
    drop = ids => dropPending($, ids)
    // A reload starts without a helper; whatever the band said is stale.
    await setStatus($, 'idle')
    // The terminal redraws on this. The desktop asks for the band on its own
    // (when a chat with messages opens, when a turn starts or ends), and draws
    // none in an empty chat; a plugin cannot make it ask sooner.
    $.ui.invalidate('ui.render')
    return started
  })

  on('command.run', { command: 'qsk' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') {
      const count = drop ? await drop() : await dropPending($)
      return { text: count ? `Removed ${plural(count, ['waiting screenshot', 'waiting screenshots'])}.` : 'No screenshots were waiting.' }
    }
    if (arg === 'folder') {
      const store = await openFolder($)
      return { text: `Attachments are kept in ${store}` }
    }
    const problem = launch ? await launch(options) : await openEditor($, options)
    return {
      text: problem
        ? `Could not open the screenshot editor: ${problem}`
        : 'Opened the screenshot editor. Attach a picture there and it goes with your next message.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !PERSON_ORIGINS.has(e.origin.kind)) return next(e)
    const stored = await read($, pending)
    // Whatever the helper saved counts too, should its report have gone missing.
    const reported = helper?.url ? await waitingOnHelper($, await hostOf($)) : []
    const list = [...stored, ...reported.filter(a => !stored.some(s => s.id === a.id))]
    if (!list.length) {
      // A message without pictures: the band's confirmation was about the one before.
      if (await read($, lastSent)) await update($, lastSent, () => null)
      return next(e)
    }
    const line = sentLine(list)
    const result = await next({
      ...e,
      text: e.text.trim() ? `${e.text}\n\n${line}` : line,
      context: [...(e.context ?? []), describeAttachments(list)],
    })
    if (result.drop === undefined) {
      const ids = list.map(a => a.id)
      await update($, pending, now => now.filter(a => !ids.includes(a.id)))
      await doneOnHelper($, ids)
      const at = await $.clock.now()
      await update($, lastSent, () => ({ at, items: list }))
    }
    return result
  }).catch(($, e, next) => next(e)) // never hold a prompt back: it goes without the picture

  // Claude opens the pictures with Read; they live outside the project, so
  // allow exactly those files instead of asking each time.
  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    const input = isRecord(e.input) ? e.input : {}
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    if (path && (await isAttachmentFile($, path))) {
      return { decision: 'allow', reason: 'A screenshot the user attached with qsketch.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a failed check allows nothing: the usual verdict stands

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, pending)
    const sent = await read($, lastSent)
    const state = await read($, status)
    const isBusy = state.phase === 'starting'
    const hasProblem = state.phase === 'error'
    // Pictures waiting win; otherwise the band confirms what the last message took.
    const sentItems = list.length ? [] : (sent?.items ?? [])
    if (!list.length && !sentItems.length && !options.showButton && !isBusy && !hasProblem) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const open = () => void (launch ? launch(options) : openEditor($, options))
    const clear = () => void (drop ? drop(list.map(a => a.id)) : dropPending($, list.map(a => a.id)))
    const dismiss = () => void update($, lastSent, () => null)

    let line = 'Mark up a screenshot and attach it to your next message.'
    let color: string | undefined
    if (sentItems.length) {
      line = `\u2713 Sent with your last message: ${plural(sentItems.length, ['annotated screenshot', 'annotated screenshots'])}.`
      color = 'success'
    }
    if (list.length) line = `\u{1F4CE} ${plural(list.length, ['annotated screenshot', 'annotated screenshots'])} will go with your next message.`
    if (isBusy) line = state.message || 'Opening the editor...'
    if (hasProblem) {
      line = state.message || 'Could not open the editor.'
      color = 'error'
    }

    const head = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="open" label={list.length ? 'Add another' : 'Annotate screenshot'} onPress={open} />
        {list.length > 0 && <Button key="clear" label="Clear" dimColor onPress={clear} />}
        {sentItems.length > 0 && <Button key="dismiss" label="Dismiss" dimColor onPress={dismiss} />}
        <Text dimColor={color === undefined} color={color} wrap="truncate-end">
          {line}
        </Text>
      </Box>
    )
    const shown = list.length ? list : sentItems
    if (!shown.length) return head

    const remove = (id: string) => () => void (drop ? drop([id]) : dropPending($, [id]))

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {shown.map((a, i) => {
              const thumb = a.thumb ? thumbnailSvg(a, 54) : undefined
              return (
                <Box key={a.id} flexDirection="row" gap={1} alignItems="center">
                  {thumb && <Svg source={thumb.source} alt={`Annotated screenshot ${i + 1}`} width={thumb.width} height={54} />}
                  <Text dimColor>{summary(a, i)}</Text>
                  {list.length > 0 && <Button key={`remove-${a.id}`} label={'\u00d7'} plain dimColor onPress={remove(a.id)} />}
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {head}
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {shown.map((a, i) => (
            <Box key={a.id} flexDirection="row" gap={1}>
              <Text dimColor>{summary(a, i)}</Text>
              {list.length > 0 && <Button key={`remove-${a.id}`} label={'\u00d7'} plain dimColor onPress={remove(a.id)} />}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
