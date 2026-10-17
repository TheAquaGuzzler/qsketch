// qsketch editor: mark up a screenshot and hand it to Claude.
//
// The qsketch helper serves this page at http://127.0.0.1:<port>/<token>/.
// Its API sits beside the page: api/attach, api/open, api/reveal, api/ping, api/clipboard.

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl+'
const FONT = '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'

const COLORS = [
  { value: '#ff3b30', name: 'Red' },
  { value: '#ff9f0a', name: 'Orange' },
  { value: '#ffd60a', name: 'Yellow' },
  { value: '#30d158', name: 'Green' },
  { value: '#0a84ff', name: 'Blue' },
  { value: '#bf5af2', name: 'Purple' },
  { value: '#ffffff', name: 'White' },
  { value: '#1c1c1e', name: 'Black' },
]
const SIZES = ['s', 'm', 'l']
const SIZE_FACTORS = { s: 1, m: 1.7, l: 2.8 }
const SIZE_NAMES = { s: 'Thin', m: 'Medium', l: 'Thick' }
const MAX_ATTACH_SIDE = 2560
const HISTORY_LIMIT = 100

const TOOLS = {
  select: { key: 'v', name: 'Select', cursor: 'default', hint: 'Click a mark to select it, drag to move it, Delete removes it. Arrow keys nudge.' },
  pen: { key: 'b', name: 'Pen', cursor: 'crosshair', hint: 'Drag to draw. Hold Shift for a straight line.' },
  highlighter: { key: 'h', name: 'Highlighter', cursor: 'crosshair', hint: 'Drag to highlight. Hold Shift for a straight line.' },
  arrow: { key: 'a', name: 'Arrow', cursor: 'crosshair', hint: 'Drag from the tail to the tip. Shift snaps the angle.' },
  rect: { key: 'r', name: 'Rectangle', cursor: 'crosshair', hint: 'Drag to draw a box. Shift makes a square.' },
  ellipse: { key: 'e', name: 'Ellipse', cursor: 'crosshair', hint: 'Drag to draw an ellipse. Shift makes a circle.' },
  text: { key: 't', name: 'Text', cursor: 'text', hint: 'Click to type a label, click a label to edit it. Esc finishes.' },
  marker: { key: 'n', name: 'Numbered marker', cursor: 'copy', hint: 'Click to place a numbered marker, then describe it on the right.' },
  crop: { key: 'c', name: 'Crop', cursor: 'crosshair', hint: 'Drag over the part to keep, then press Enter.' },
  eraser: { key: 'x', name: 'Eraser', cursor: 'crosshair', hint: 'Click or drag over marks to delete them.' },
}
const TOOL_BY_KEY = Object.fromEntries(Object.entries(TOOLS).map(([id, tool]) => [tool.key, id]))

// ---------------------------------------------------------------- elements

const byIdEl = id => document.getElementById(id)
const wrap = byIdEl('canvas-wrap')
const canvas = byIdEl('stage')
const ctx = canvas.getContext('2d')
const textEditor = byIdEl('text-editor')
const cropBar = byIdEl('crop-bar')
const emptyView = byIdEl('empty')
const doneView = byIdEl('done')
const notesList = byIdEl('notes')
const notesHint = byIdEl('notes-hint')
const commentField = byIdEl('comment')
const closeAfterBox = byIdEl('close-after')
const legendBox = byIdEl('legend')
const autoCopyBox = byIdEl('auto-copy')
const fileInput = byIdEl('file-input')
const toastEl = byIdEl('toast')
const undoBtn = byIdEl('undo')
const redoBtn = byIdEl('redo')
const clearBtn = byIdEl('clear')
const copyBtn = byIdEl('copy')
const saveBtn = byIdEl('save')
const attachBtn = byIdEl('attach')
const sizeLabel = byIdEl('status-size')
const zoomLabel = byIdEl('zoom-label')
const hintLabel = byIdEl('status-hint')
const toolButtons = [...document.querySelectorAll('[data-tool]')]
const sizeButtons = [...document.querySelectorAll('[data-size]')]
const swatches = []
const measure = document.createElement('canvas').getContext('2d')

// ---------------------------------------------------------------- settings

const settings = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('qsketch.' + key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('qsketch.' + key, JSON.stringify(value))
    } catch {
      // Storage is a convenience; the editor works without it.
    }
  },
}

function savedTool() {
  const tool = settings.get('tool', 'pen')
  return TOOLS[tool] && tool !== 'crop' ? tool : 'pen'
}

function savedColor() {
  const color = settings.get('color', COLORS[0].value)
  return COLORS.some(c => c.value === color) ? color : COLORS[0].value
}

function savedSize() {
  const size = settings.get('size', 'm')
  return SIZES.includes(size) ? size : 'm'
}

// ---------------------------------------------------------------- state

const state = {
  image: null,
  width: 0,
  height: 0,
  shapes: [],
  notes: new Map(),
  tool: savedTool(),
  previousTool: 'pen',
  color: savedColor(),
  size: savedSize(),
  selectedId: null,
  hoverMarkerId: null,
  view: { scale: 1, x: 0, y: 0, fitted: true },
  undo: [],
  redo: [],
  draft: null,
  gesture: null,
  crop: null,
  editing: null,
  space: false,
  busy: false,
  used: false,
  nextId: 1,
}

let cssWidth = 0
let cssHeight = 0
let dpr = 1
let frame = 0

const byId = id => state.shapes.find(s => s.id === id) || null
const selected = () => (state.selectedId === null ? null : byId(state.selectedId))
const isEditing = s => state.editing !== null && state.editing.shape.id === s.id
const markers = () => state.shapes.filter(s => s.type === 'marker')

// ---------------------------------------------------------------- units

// Marks scale with the screenshot, so a 4K capture and a small snip look alike.
const unit = () => Math.max(1.25, Math.max(state.width, state.height) / 640)
const lineWidthFor = size => unit() * 1.5 * SIZE_FACTORS[size]
const fontSizeFor = size => unit() * 7.5 * SIZE_FACTORS[size]
const markerRadiusFor = size => unit() * (4.5 + 2.2 * SIZE_FACTORS[size])

function applySize(shape) {
  if (shape.type === 'text') shape.fs = fontSizeFor(shape.size)
  else if (shape.type === 'marker') shape.r = markerRadiusFor(shape.size)
  else shape.lw = lineWidthFor(shape.size) * (shape.type === 'highlighter' ? 4 : 1)
}

function newShape(type, extra) {
  const shape = { id: state.nextId++, type, color: state.color, size: state.size, ...extra }
  applySize(shape)
  return shape
}

// ---------------------------------------------------------------- colors

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const channel = v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

const textColorOn = hex => (luminance(hex) > 0.45 ? '#111114' : '#ffffff')
const outlineFor = hex => (luminance(hex) > 0.45 ? 'rgba(17, 17, 20, 0.9)' : 'rgba(255, 255, 255, 0.92)')

// ---------------------------------------------------------------- geometry

function rectOf(s) {
  return {
    x: Math.min(s.x1, s.x2),
    y: Math.min(s.y1, s.y2),
    w: Math.abs(s.x2 - s.x1),
    h: Math.abs(s.y2 - s.y1),
  }
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function textMetrics(s) {
  measure.font = `700 ${s.fs}px ${FONT}`
  const lines = (s.text || '').split('\n')
  const lineHeight = s.fs * 1.25
  const width = Math.max(s.fs * 0.5, ...lines.map(line => measure.measureText(line).width))
  return { lines, lineHeight, width, height: lines.length * lineHeight }
}

function arrowGeometry(s) {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const head = Math.min(length * 0.6, s.lw * 4.2)
  const half = head * 0.55
  const bx = s.x2 - ux * head
  const by = s.y2 - uy * head
  return {
    tip: [s.x2, s.y2],
    left: [bx - uy * half, by + ux * half],
    right: [bx + uy * half, by - ux * half],
    base: [s.x2 - ux * head * 0.7, s.y2 - uy * head * 0.7],
    head,
  }
}

function boundsOf(s) {
  switch (s.type) {
    case 'pen':
    case 'highlighter': {
      const xs = s.points.map(p => p[0])
      const ys = s.points.map(p => p[1])
      const pad = s.lw / 2
      const x = Math.min(...xs) - pad
      const y = Math.min(...ys) - pad
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
    }
    case 'arrow': {
      const r = rectOf(s)
      const pad = s.lw * 2
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }
    }
    case 'rect':
    case 'ellipse': {
      const r = rectOf(s)
      const pad = s.lw / 2
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }
    }
    case 'text': {
      const m = textMetrics(s)
      return { x: s.x, y: s.y, w: m.width, h: m.height }
    }
    case 'marker':
      return { x: s.x - s.r, y: s.y - s.r, w: s.r * 2, h: s.r * 2 }
    default:
      return { x: 0, y: 0, w: 0, h: 0 }
  }
}

function hitShape(s, p, tol) {
  switch (s.type) {
    case 'pen':
    case 'highlighter': {
      const reach = s.lw / 2 + tol
      const pts = s.points
      if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= reach
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(p.x, p.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true
      }
      return false
    }
    case 'arrow': {
      if (distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= s.lw / 2 + tol) return true
      const a = arrowGeometry(s)
      return Math.hypot(p.x - s.x2, p.y - s.y2) <= a.head * 0.6 + tol
    }
    case 'rect': {
      const r = rectOf(s)
      const reach = s.lw / 2 + tol
      const outside = p.x < r.x - reach || p.x > r.x + r.w + reach || p.y < r.y - reach || p.y > r.y + r.h + reach
      const inside = p.x > r.x + reach && p.x < r.x + r.w - reach && p.y > r.y + reach && p.y < r.y + r.h - reach
      return !outside && !inside
    }
    case 'ellipse': {
      const r = rectOf(s)
      const rx = r.w / 2
      const ry = r.h / 2
      if (rx < 1 || ry < 1) return distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= s.lw / 2 + tol
      const d = Math.hypot((p.x - r.x - rx) / rx, (p.y - r.y - ry) / ry)
      return Math.abs(d - 1) * Math.min(rx, ry) <= s.lw / 2 + tol
    }
    case 'text': {
      const m = textMetrics(s)
      return p.x >= s.x - tol && p.x <= s.x + m.width + tol && p.y >= s.y - tol && p.y <= s.y + m.height + tol
    }
    case 'marker':
      return Math.hypot(p.x - s.x, p.y - s.y) <= s.r + tol
    default:
      return false
  }
}

function insideShape(s, p) {
  if (s.type === 'rect') {
    const r = rectOf(s)
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  }
  if (s.type === 'ellipse') {
    const r = rectOf(s)
    if (r.w < 2 || r.h < 2) return false
    return Math.hypot((p.x - r.x - r.w / 2) / (r.w / 2), (p.y - r.y - r.h / 2) / (r.h / 2)) <= 1
  }
  return false
}

function hitTest(p, interior = true) {
  const tol = 6 / state.view.scale
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    if (hitShape(state.shapes[i], p, tol)) return state.shapes[i]
  }
  if (interior) {
    for (let i = state.shapes.length - 1; i >= 0; i--) {
      if (insideShape(state.shapes[i], p)) return state.shapes[i]
    }
  }
  return null
}

function handlesOf(s) {
  if (s.type === 'arrow') {
    return [
      { key: 'p1', x: s.x1, y: s.y1 },
      { key: 'p2', x: s.x2, y: s.y2 },
    ]
  }
  if (s.type === 'rect' || s.type === 'ellipse') {
    const r = rectOf(s)
    return [
      { key: 'nw', x: r.x, y: r.y },
      { key: 'ne', x: r.x + r.w, y: r.y },
      { key: 'sw', x: r.x, y: r.y + r.h },
      { key: 'se', x: r.x + r.w, y: r.y + r.h },
    ]
  }
  return []
}

function hitHandle(s, p) {
  const tol = 8 / state.view.scale
  return handlesOf(s).find(h => Math.abs(h.x - p.x) <= tol && Math.abs(h.y - p.y) <= tol) || null
}

function translate(s, dx, dy) {
  if (s.points) s.points = s.points.map(([x, y]) => [x + dx, y + dy])
  if ('x1' in s) {
    s.x1 += dx
    s.y1 += dy
    s.x2 += dx
    s.y2 += dy
  }
  if (s.type === 'text' || s.type === 'marker') {
    s.x += dx
    s.y += dy
  }
}

function applyHandle(s, handle, p) {
  if (s.type === 'arrow') {
    if (handle === 'p1') {
      s.x1 = p.x
      s.y1 = p.y
    } else {
      s.x2 = p.x
      s.y2 = p.y
    }
    return
  }
  if (handle.includes('w')) s.x1 = p.x
  if (handle.includes('e')) s.x2 = p.x
  if (handle.includes('n')) s.y1 = p.y
  if (handle.includes('s')) s.y2 = p.y
}

function normalizeBox(s) {
  if (s.type !== 'rect' && s.type !== 'ellipse') return
  const r = rectOf(s)
  s.x1 = r.x
  s.y1 = r.y
  s.x2 = r.x + r.w
  s.y2 = r.y + r.h
}

// ---------------------------------------------------------------- drawing

function markerNumbers() {
  const numbers = new Map()
  markers().forEach((m, i) => numbers.set(m.id, i + 1))
  return numbers
}

function strokePath(g, points) {
  g.beginPath()
  g.moveTo(points[0][0], points[0][1])
  if (points.length === 1) {
    g.lineTo(points[0][0] + 0.01, points[0][1])
    return
  }
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    g.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
  }
  const last = points[points.length - 1]
  g.lineTo(last[0], last[1])
}

// `k` is device pixels per image pixel: shadows are not scaled by transforms.
function drawShape(g, s, k, number) {
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const shadow = (size) => {
    g.shadowColor = 'rgba(0, 0, 0, 0.38)'
    g.shadowBlur = Math.max(1.5, size) * k
    g.shadowOffsetY = size * 0.18 * k
  }
  switch (s.type) {
    case 'pen':
      shadow(s.lw * 0.8)
      g.strokeStyle = s.color
      g.lineWidth = s.lw
      strokePath(g, s.points)
      g.stroke()
      break
    case 'highlighter':
      g.globalAlpha = 0.4
      g.strokeStyle = s.color
      g.lineWidth = s.lw
      strokePath(g, s.points)
      g.stroke()
      break
    case 'arrow': {
      shadow(s.lw * 0.8)
      const a = arrowGeometry(s)
      g.strokeStyle = s.color
      g.fillStyle = s.color
      g.lineWidth = s.lw
      g.beginPath()
      g.moveTo(s.x1, s.y1)
      g.lineTo(a.base[0], a.base[1])
      g.stroke()
      g.beginPath()
      g.moveTo(a.tip[0], a.tip[1])
      g.lineTo(a.left[0], a.left[1])
      g.lineTo(a.right[0], a.right[1])
      g.closePath()
      g.lineWidth = s.lw * 0.5
      g.fill()
      g.stroke()
      break
    }
    case 'rect': {
      shadow(s.lw * 0.8)
      const r = rectOf(s)
      g.strokeStyle = s.color
      g.lineWidth = s.lw
      g.beginPath()
      if (g.roundRect) g.roundRect(r.x, r.y, r.w, r.h, Math.min(s.lw * 0.8, r.w / 2, r.h / 2))
      else g.rect(r.x, r.y, r.w, r.h)
      g.stroke()
      break
    }
    case 'ellipse': {
      shadow(s.lw * 0.8)
      const r = rectOf(s)
      g.strokeStyle = s.color
      g.lineWidth = s.lw
      g.beginPath()
      g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w / 2, 0.5), Math.max(r.h / 2, 0.5), 0, 0, Math.PI * 2)
      g.stroke()
      break
    }
    case 'text': {
      const m = textMetrics(s)
      g.font = `700 ${s.fs}px ${FONT}`
      g.textBaseline = 'top'
      g.lineWidth = s.fs * 0.22
      g.strokeStyle = outlineFor(s.color)
      g.fillStyle = s.color
      m.lines.forEach((line, i) => {
        const y = s.y + i * m.lineHeight + (m.lineHeight - s.fs) / 2
        g.strokeText(line, s.x, y)
        g.fillText(line, s.x, y)
      })
      break
    }
    case 'marker': {
      shadow(s.r * 0.35)
      g.beginPath()
      g.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      g.fillStyle = s.color
      g.fill()
      g.shadowColor = 'transparent'
      g.lineWidth = s.r * 0.17
      g.strokeStyle = luminance(s.color) > 0.7 ? '#1c1c1e' : '#ffffff'
      g.stroke()
      const label = String(number ?? '?')
      g.fillStyle = textColorOn(s.color)
      g.font = `700 ${s.r * (label.length > 1 ? 0.95 : 1.15)}px ${FONT}`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(label, s.x, s.y + s.r * 0.06)
      break
    }
  }
  g.restore()
}

function resizeCanvas() {
  const rect = wrap.getBoundingClientRect()
  dpr = window.devicePixelRatio || 1
  cssWidth = rect.width
  cssHeight = rect.height
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
}

function render() {
  if (!frame) frame = requestAnimationFrame(draw)
}

function draw() {
  frame = 0
  if (Math.abs((window.devicePixelRatio || 1) - dpr) > 0.001) resizeCanvas()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!state.image) return

  const { scale, x, y } = state.view
  const k = scale * dpr
  ctx.setTransform(k, 0, 0, k, x * dpr, y * dpr)

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
  ctx.shadowBlur = 22 * dpr
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, state.width, state.height)
  ctx.restore()

  ctx.imageSmoothingEnabled = scale < 2
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(state.image, 0, 0)

  // Marks are clipped to the picture, as the exported image clips them.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, state.width, state.height)
  ctx.clip()
  const numbers = markerNumbers()
  for (const s of state.shapes) {
    if (!isEditing(s)) drawShape(ctx, s, k, numbers.get(s.id))
  }
  if (state.draft) drawShape(ctx, state.draft, k, numbers.size + 1)
  ctx.restore()

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawHoverMarker()
  drawSelection()
  drawCrop()
}

function toScreen(x, y) {
  return { x: state.view.x + x * state.view.scale, y: state.view.y + y * state.view.scale }
}

function toImage(event) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left - state.view.x) / state.view.scale,
    y: (event.clientY - rect.top - state.view.y) / state.view.scale,
  }
}

function drawSelection() {
  const s = selected()
  if (!s) return
  const scale = state.view.scale
  ctx.save()
  if (s.type !== 'arrow') {
    const b = boundsOf(s)
    const a = toScreen(b.x, b.y)
    ctx.strokeStyle = '#e0825f'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    ctx.strokeRect(a.x - 5, a.y - 5, b.w * scale + 10, b.h * scale + 10)
    ctx.setLineDash([])
  }
  for (const h of handlesOf(s)) {
    const p = toScreen(h.x, h.y)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#e0825f'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(p.x - 5, p.y - 5, 10, 10)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

function drawHoverMarker() {
  if (state.hoverMarkerId === null) return
  const m = byId(state.hoverMarkerId)
  if (!m) return
  const p = toScreen(m.x, m.y)
  ctx.save()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.arc(p.x, p.y, m.r * state.view.scale + 7, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

function cropRect() {
  const c = state.crop
  if (!c) return null
  return { x: Math.min(c.x1, c.x2), y: Math.min(c.y1, c.y2), w: Math.abs(c.x2 - c.x1), h: Math.abs(c.y2 - c.y1) }
}

function drawCrop() {
  const r = cropRect()
  if (!r) return
  const scale = state.view.scale
  const a = toScreen(r.x, r.y)
  const origin = toScreen(0, 0)
  ctx.save()
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.beginPath()
  ctx.rect(origin.x, origin.y, state.width * scale, state.height * scale)
  ctx.rect(a.x, a.y, r.w * scale, r.h * scale)
  ctx.fill('evenodd')
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 4])
  ctx.strokeRect(a.x, a.y, r.w * scale, r.h * scale)
  ctx.setLineDash([])
  const label = `${Math.round(r.w)} × ${Math.round(r.h)}`
  ctx.font = `600 12px ${FONT}`
  const width = ctx.measureText(label).width + 14
  const top = a.y > 28 ? a.y - 26 : a.y + 6
  ctx.fillStyle = 'rgba(20, 20, 24, 0.9)'
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(a.x, top, width, 20, 6)
  else ctx.rect(a.x, top, width, 20)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, a.x + 7, top + 10.5)
  ctx.restore()
}

// ---------------------------------------------------------------- view

function clampView() {
  const v = state.view
  const width = state.width * v.scale
  const height = state.height * v.scale
  const margin = 40
  v.x = width <= cssWidth ? (cssWidth - width) / 2 : Math.min(margin, Math.max(cssWidth - width - margin, v.x))
  v.y = height <= cssHeight ? (cssHeight - height) / 2 : Math.min(margin, Math.max(cssHeight - height - margin, v.y))
}

function fitView() {
  if (!state.image) return
  const pad = 28
  const fit = Math.min((cssWidth - pad * 2) / state.width, (cssHeight - pad * 2) / state.height)
  state.view.scale = Math.max(0.05, Math.min(fit, 2))
  state.view.fitted = true
  clampView()
  updateZoomLabel()
  positionTextEditor()
  render()
}

function zoomAt(factor, clientX, clientY) {
  if (!state.image) return
  const rect = canvas.getBoundingClientRect()
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  const v = state.view
  const ix = (sx - v.x) / v.scale
  const iy = (sy - v.y) / v.scale
  v.scale = Math.min(8, Math.max(0.05, v.scale * factor))
  v.x = sx - ix * v.scale
  v.y = sy - iy * v.scale
  v.fitted = false
  clampView()
  updateZoomLabel()
  positionTextEditor()
  render()
}

function zoomCenter(factor) {
  const rect = canvas.getBoundingClientRect()
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function updateZoomLabel() {
  zoomLabel.textContent = state.image ? `${Math.round(state.view.scale * 100)}%` : '–'
}

// ---------------------------------------------------------------- history

function snapshot() {
  return { image: state.image, width: state.width, height: state.height, shapes: structuredClone(state.shapes) }
}

function pushHistory() {
  state.undo.push(snapshot())
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift()
  state.redo = []
  state.used = false
}

function restore(snap) {
  const resized = snap.image !== state.image
  state.image = snap.image
  state.width = snap.width
  state.height = snap.height
  state.shapes = snap.shapes
  state.selectedId = null
  state.crop = null
  cropBar.hidden = true
  if (resized) fitView()
  afterChange()
}

function undo() {
  commitTextEdit()
  if (!state.undo.length) return
  state.redo.push(snapshot())
  restore(state.undo.pop())
}

function redo() {
  commitTextEdit()
  if (!state.redo.length) return
  state.undo.push(snapshot())
  restore(state.redo.pop())
}

function afterChange() {
  renderNotes()
  updateUI()
  render()
  scheduleAutoCopy()
}

function removeShape(id) {
  if (!byId(id)) return
  pushHistory()
  state.shapes = state.shapes.filter(s => s.id !== id)
  if (state.selectedId === id) state.selectedId = null
  afterChange()
}

function clearMarks() {
  if (!state.shapes.length) return
  commitTextEdit()
  pushHistory()
  state.shapes = []
  state.selectedId = null
  afterChange()
  toast('Removed all marks. Undo brings them back.')
}

// ---------------------------------------------------------------- tools

function setTool(tool) {
  if (!TOOLS[tool]) return
  commitTextEdit()
  if (state.tool === 'crop' && tool !== 'crop') cancelCrop()
  if (tool === 'crop' && state.tool !== 'crop') state.previousTool = state.tool
  if (tool !== 'select') state.selectedId = null
  state.tool = tool
  if (tool !== 'crop') settings.set('tool', tool)
  updateUI()
  render()
}

function editTarget() {
  return state.editing ? state.editing.shape : selected()
}

function setColor(value) {
  state.color = value
  settings.set('color', value)
  const target = editTarget()
  if (target && target.color !== value) {
    if (!(state.editing && state.editing.isNew)) pushHistory()
    target.color = value
    positionTextEditor()
    afterChange()
  }
  updateUI()
}

function setSize(size) {
  state.size = size
  settings.set('size', size)
  const target = editTarget()
  if (target && target.size !== size) {
    if (!(state.editing && state.editing.isNew)) pushHistory()
    target.size = size
    applySize(target)
    positionTextEditor()
    afterChange()
  }
  updateUI()
}

function cycleSize(step) {
  const i = SIZES.indexOf(state.size)
  setSize(SIZES[Math.max(0, Math.min(SIZES.length - 1, i + step))])
}

function placeMarker(p) {
  pushHistory()
  const marker = newShape('marker', { x: p.x, y: p.y })
  state.shapes.push(marker)
  afterChange()
  return marker
}

function eraseAt(p) {
  const hit = hitTest(p, false)
  if (!hit) return
  if (!state.gesture.changed) {
    pushHistory()
    state.gesture.changed = true
  }
  state.shapes = state.shapes.filter(s => s.id !== hit.id)
  if (state.selectedId === hit.id) state.selectedId = null
  renderNotes()
}

function clampPoint(p) {
  return { x: Math.max(0, Math.min(state.width, p.x)), y: Math.max(0, Math.min(state.height, p.y)) }
}

function finishCropDrag() {
  const r = cropRect()
  const min = 4 / state.view.scale
  if (!r || r.w < min || r.h < min) {
    cancelCrop()
    return
  }
  cropBar.hidden = false
}

function applyCrop() {
  const r = cropRect()
  if (!r) return
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const w = Math.max(1, Math.round(r.w))
  const h = Math.max(1, Math.round(r.h))
  pushHistory()
  const cropped = document.createElement('canvas')
  cropped.width = w
  cropped.height = h
  cropped.getContext('2d').drawImage(state.image, -x, -y)
  state.image = cropped
  state.width = w
  state.height = h
  for (const s of state.shapes) translate(s, -x, -y)
  // Marks left wholly outside would vanish from the picture but not from the
  // notes, so they go (undo brings them back).
  state.shapes = state.shapes.filter(s => {
    const b = boundsOf(s)
    return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0
  })
  state.crop = null
  cropBar.hidden = true
  fitView()
  setTool(state.previousTool || 'pen')
  afterChange()
}

function cancelCrop() {
  state.crop = null
  cropBar.hidden = true
  render()
}

function updateDraft(p, shift) {
  const d = state.draft
  if (!d) return
  if (d.type === 'pen' || d.type === 'highlighter') {
    if (shift) {
      d.points = [d.points[0], [p.x, p.y]]
      return
    }
    const last = d.points[d.points.length - 1]
    if (Math.hypot(p.x - last[0], p.y - last[1]) * state.view.scale >= 1.5) d.points.push([p.x, p.y])
    return
  }
  let x = p.x
  let y = p.y
  if (shift) {
    const dx = x - d.x1
    const dy = y - d.y1
    if (d.type === 'arrow') {
      const length = Math.hypot(dx, dy)
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
      x = d.x1 + Math.cos(angle) * length
      y = d.y1 + Math.sin(angle) * length
    } else {
      const side = Math.max(Math.abs(dx), Math.abs(dy))
      x = d.x1 + Math.sign(dx || 1) * side
      y = d.y1 + Math.sign(dy || 1) * side
    }
  }
  d.x2 = x
  d.y2 = y
}

function finishDraft() {
  const d = state.draft
  state.draft = null
  if (!d) return
  const min = 4 / state.view.scale
  if (d.type === 'arrow' && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < min * 2) return
  if ((d.type === 'rect' || d.type === 'ellipse') && (Math.abs(d.x2 - d.x1) < min || Math.abs(d.y2 - d.y1) < min)) return
  normalizeBox(d)
  pushHistory()
  state.shapes.push(d)
  afterChange()
}

// ---------------------------------------------------------------- text

function beginTextEdit(shape, isNew) {
  state.editing = { shape, isNew, original: shape.text || '' }
  state.selectedId = null
  textEditor.value = shape.text || ''
  textEditor.hidden = false
  positionTextEditor()
  render()
  requestAnimationFrame(() => {
    textEditor.focus()
    textEditor.setSelectionRange(textEditor.value.length, textEditor.value.length)
  })
}

function positionTextEditor() {
  const ed = state.editing
  if (!ed) return
  const s = ed.shape
  const fontSize = s.fs * state.view.scale
  const p = toScreen(s.x, s.y)
  measure.font = `700 ${fontSize}px ${FONT}`
  const lines = textEditor.value.split('\n')
  const width = Math.max(fontSize * 0.6, ...lines.map(line => measure.measureText(line).width))
  textEditor.style.left = `${p.x}px`
  textEditor.style.top = `${p.y}px`
  textEditor.style.fontSize = `${fontSize}px`
  textEditor.style.color = s.color
  textEditor.style.width = `${Math.ceil(width + fontSize)}px`
  textEditor.style.height = `${Math.ceil(lines.length * fontSize * 1.25 + 2)}px`
}

function commitTextEdit() {
  const ed = state.editing
  if (!ed) return
  state.editing = null
  const text = textEditor.value.replace(/\s+$/, '')
  textEditor.hidden = true
  if (document.activeElement === textEditor) textEditor.blur()
  const s = ed.shape
  if (ed.isNew) {
    if (text) {
      pushHistory()
      s.text = text
      state.shapes.push(s)
    }
  } else if (text !== ed.original) {
    pushHistory()
    if (text) s.text = text
    else state.shapes = state.shapes.filter(x => x.id !== s.id)
  }
  afterChange()
}

// ---------------------------------------------------------------- notes

function autoGrow(area) {
  area.style.height = 'auto'
  area.style.height = `${area.scrollHeight + 2}px`
}

function setHoverMarker(id) {
  if (state.hoverMarkerId === id) return
  state.hoverMarkerId = id
  render()
}

function createNoteRow(marker) {
  const id = marker.id
  const li = document.createElement('li')
  li.className = 'note'
  li.dataset.id = String(id)

  const badge = document.createElement('button')
  badge.type = 'button'
  badge.className = 'badge'
  badge.title = 'Select this marker'

  const area = document.createElement('textarea')
  area.rows = 1
  area.placeholder = 'What should change here?'
  area.value = state.notes.get(id) || ''

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'remove'
  remove.title = 'Remove this marker'
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'

  area.addEventListener('input', () => {
    state.notes.set(id, area.value)
    state.used = false
    autoGrow(area)
    scheduleAutoCopy()
  })
  area.addEventListener('keydown', e => {
    if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === 'Escape') {
      e.preventDefault()
      area.blur()
    }
  })
  area.addEventListener('focus', () => {
    li.classList.add('active')
    setHoverMarker(id)
  })
  area.addEventListener('blur', () => {
    li.classList.remove('active')
    setHoverMarker(null)
  })
  li.addEventListener('mouseenter', () => setHoverMarker(id))
  li.addEventListener('mouseleave', () => {
    if (document.activeElement !== area) setHoverMarker(null)
  })
  badge.addEventListener('click', () => {
    setTool('select')
    state.selectedId = id
    updateUI()
    render()
  })
  remove.addEventListener('click', () => removeShape(id))

  li.append(badge, area, remove)
  requestAnimationFrame(() => autoGrow(area))
  return li
}

function renderNotes() {
  const list = markers()
  notesHint.hidden = list.length > 0
  const rows = new Map([...notesList.children].map(li => [li.dataset.id, li]))
  list.forEach((m, i) => {
    const key = String(m.id)
    let li = rows.get(key)
    if (li) rows.delete(key)
    else li = createNoteRow(m)
    const badge = li.querySelector('.badge')
    badge.textContent = String(i + 1)
    badge.style.background = m.color
    badge.style.color = textColorOn(m.color)
    if (notesList.children[i] !== li) notesList.insertBefore(li, notesList.children[i] || null)
  })
  for (const li of rows.values()) li.remove()
}

function focusNote(id) {
  const area = notesList.querySelector(`li[data-id="${id}"] textarea`)
  if (area) area.focus()
}

function noteEntries() {
  return markers().map((m, i) => ({ n: i + 1, text: (state.notes.get(m.id) || '').trim(), color: m.color }))
}

function hasNotes() {
  return noteEntries().some(n => n.text) || commentField.value.trim() !== ''
}

// ---------------------------------------------------------------- export

function wrapText(g, text, maxWidth) {
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (g.measureText(candidate).width <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      line = ''
      let chunk = ''
      for (const ch of word) {
        if (chunk && g.measureText(chunk + ch).width > maxWidth) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      line = chunk
    }
    lines.push(line)
  }
  return lines
}

function layoutLegend(width) {
  const items = noteEntries().filter(n => n.text)
  const comment = commentField.value.trim()
  if (!items.length && !comment) return null
  const u = Math.max(1.25, width / 640)
  const font = Math.round(7.5 * u)
  const lineHeight = Math.round(font * 1.35)
  const pad = Math.round(12 * u)
  const badge = Math.round(font * 0.72)
  const gap = Math.round(7 * u)
  const textX = pad + badge * 2 + gap
  measure.font = `500 ${font}px ${FONT}`
  const rows = []
  let y = pad
  for (const item of items) {
    const lines = wrapText(measure, item.text, width - textX - pad)
    rows.push({ ...item, lines, y })
    y += Math.max(badge * 2, lines.length * lineHeight) + gap
  }
  let commentBlock = null
  if (comment) {
    const lines = wrapText(measure, comment, width - pad * 2)
    commentBlock = { lines, y }
    y += lineHeight * (lines.length + 1) + gap
  }
  return { font, lineHeight, pad, badge, gap, textX, rows, commentBlock, height: y - gap + pad }
}

function drawLegend(g, L, top, width) {
  g.save()
  g.translate(0, top)
  g.fillStyle = '#16161a'
  g.fillRect(0, 0, width, L.height)
  g.fillStyle = 'rgba(255, 255, 255, 0.1)'
  g.fillRect(0, 0, width, Math.max(1, Math.round(L.font / 12)))
  for (const row of L.rows) {
    const cx = L.pad + L.badge
    const cy = row.y + L.badge
    g.beginPath()
    g.arc(cx, cy, L.badge, 0, Math.PI * 2)
    g.fillStyle = row.color
    g.fill()
    g.fillStyle = textColorOn(row.color)
    g.font = `700 ${Math.round(L.badge * 1.1)}px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(String(row.n), cx, cy + 1)
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = '#ececf1'
    g.font = `500 ${L.font}px ${FONT}`
    row.lines.forEach((line, i) => {
      const lineTop = row.lines.length === 1 ? cy - L.lineHeight / 2 : row.y + i * L.lineHeight
      g.fillText(line, L.textX, lineTop + L.lineHeight / 2)
    })
  }
  if (L.commentBlock) {
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = '#9b9ba8'
    g.font = `700 ${L.font}px ${FONT}`
    g.fillText('Comment', L.pad, L.commentBlock.y + L.lineHeight / 2)
    g.fillStyle = '#ececf1'
    g.font = `500 ${L.font}px ${FONT}`
    L.commentBlock.lines.forEach((line, i) => {
      g.fillText(line, L.pad, L.commentBlock.y + (i + 1) * L.lineHeight + L.lineHeight / 2)
    })
  }
  g.restore()
}

function exportCanvas({ legend = false, maxSide = Infinity } = {}) {
  const scale = Math.min(1, maxSide / Math.max(state.width, state.height))
  const w = Math.max(1, Math.round(state.width * scale))
  const h = Math.max(1, Math.round(state.height * scale))
  const L = legend ? layoutLegend(w) : null
  const out = document.createElement('canvas')
  out.width = w
  out.height = h + (L ? L.height : 0)
  const g = out.getContext('2d')
  g.save()
  g.scale(scale, scale)
  g.imageSmoothingQuality = 'high'
  g.drawImage(state.image, 0, 0)
  const numbers = markerNumbers()
  for (const s of state.shapes) drawShape(g, s, scale, numbers.get(s.id))
  g.restore()
  if (L) drawLegend(g, L, h, w)
  return out
}

function toBlob(source) {
  return new Promise((resolve, reject) => {
    source.toBlob(blob => (blob ? resolve(blob) : reject(new Error('the image could not be encoded'))), 'image/png')
  })
}

function thumbnailDataUrl(source) {
  const scale = Math.min(360 / source.width, 220 / source.height, 1)
  const thumb = document.createElement('canvas')
  thumb.width = Math.max(1, Math.round(source.width * scale))
  thumb.height = Math.max(1, Math.round(source.height * scale))
  const g = thumb.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, 0, 0, thumb.width, thumb.height)
  return thumb.toDataURL('image/jpeg', 0.72)
}

function markCounts() {
  const counts = {}
  for (const s of state.shapes) counts[s.type] = (counts[s.type] || 0) + 1
  return counts
}

function timestamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// ---------------------------------------------------------------- actions

async function attach() {
  if (!state.image || state.busy) return
  commitTextEdit()
  cancelCrop()
  state.busy = true
  attachBtn.classList.add('busy')
  updateUI()
  try {
    const picture = exportCanvas({ maxSide: MAX_ATTACH_SIDE })
    const png = await toBlob(picture)
    const meta = {
      version: 1,
      width: picture.width,
      height: picture.height,
      notes: noteEntries().map(({ n, text }) => ({ n, text })),
      comment: commentField.value.trim(),
      marks: markCounts(),
      thumb: thumbnailDataUrl(picture),
      createdAt: new Date().toISOString(),
    }
    const body = new Blob([JSON.stringify(meta) + '\n', png], { type: 'application/octet-stream' })
    const response = await fetch('api/attach', { method: 'POST', body })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.ok) throw new Error(result.error || `the helper answered ${response.status}`)
    state.used = true
    showDone()
  } catch (error) {
    const reason = error instanceof TypeError ? 'Claude is not reachable. Is the session still open?' : error.message
    toast(`Could not attach: ${reason} You can still copy or save the image.`, 'error', 6000)
  } finally {
    state.busy = false
    attachBtn.classList.remove('busy')
    updateUI()
  }
}

async function copyImage() {
  if (!state.image) return
  commitTextEdit()
  try {
    const blob = toBlob(exportCanvas({ legend: legendBox.checked && hasNotes() }))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    state.used = true
    toast(`Copied. Paste it into Claude's message box with ${MOD}V.`, 'ok', 4000)
  } catch (error) {
    toast(`Could not copy the image: ${error.message}`, 'error', 5000)
  }
}

// Keeps the clipboard holding the latest marked-up image, so it can be pasted
// into Claude without clicking Copy. Quiet: a failed write (say, the window
// lost focus) is tried again on the next edit.
let autoCopyTimer = 0

function scheduleAutoCopy() {
  clearTimeout(autoCopyTimer)
  if (!autoCopyBox.checked || !state.image) return
  autoCopyTimer = setTimeout(async () => {
    if (!state.image || state.draft) return
    try {
      const blob = toBlob(exportCanvas({ legend: legendBox.checked && hasNotes() }))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch {
      // Tried again on the next change.
    }
  }, 600)
}

async function saveImage() {
  if (!state.image) return
  commitTextEdit()
  const name = `screenshot-${timestamp()}.png`
  let blob
  try {
    blob = await toBlob(exportCanvas({ legend: legendBox.checked && hasNotes() }))
  } catch (error) {
    toast(`Could not save: ${error.message}`, 'error')
    return
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        startIn: 'pictures',
        types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      state.used = true
      toast(`Saved as ${handle.name}.`, 'ok')
    } catch (error) {
      if (error.name !== 'AbortError') toast(`Could not save: ${error.message}`, 'error')
    }
    return
  }
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
  state.used = true
}

function showDone() {
  doneView.hidden = false
  if (closeAfterBox.checked) {
    setTimeout(() => {
      window.close()
      setTimeout(() => toast('Attached. You can close this window.'), 300)
    }, 1100)
  }
}

function resetDocument() {
  commitTextEdit()
  state.image = null
  state.width = 0
  state.height = 0
  state.shapes = []
  state.notes.clear()
  state.undo = []
  state.redo = []
  state.selectedId = null
  state.crop = null
  state.draft = null
  state.used = false
  cropBar.hidden = true
  commentField.value = ''
  autoGrow(commentField)
  doneView.hidden = true
  afterChange()
}

async function loadImageBlob(blob) {
  if (!blob) return
  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    toast('That file is not an image the editor can open.', 'error')
    return
  }
  const hasWork = state.image && (state.shapes.length || hasNotes())
  if (hasWork && !state.used && !window.confirm('Replace the current screenshot? Your marks on it will be lost.')) {
    bitmap.close()
    return
  }
  const base = document.createElement('canvas')
  base.width = bitmap.width
  base.height = bitmap.height
  base.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  resetDocument()
  state.image = base
  state.width = base.width
  state.height = base.height
  fitView()
  afterChange()
}

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (type) {
        await loadImageBlob(await item.getType(type))
        return
      }
    }
    toast(`The clipboard holds no image. ${snipHint()}`)
  } catch {
    toast(`Press ${MOD}V to paste the screenshot instead.`)
  }
}

// A screenshot already on the clipboard opens as soon as the window does.
async function loadClipboardOnStart() {
  try {
    const response = await fetch('api/clipboard')
    if (response.status !== 200 || state.image) return
    await loadImageBlob(await response.blob())
  } catch {
    // Nothing to open: the drop zone asks for a paste as usual.
  }
}

function snipHint() {
  return isMac ? 'Press ⌘+Ctrl+Shift+4 to copy part of the screen.' : 'Press Win+Shift+S to capture part of the screen.'
}

function api(path) {
  return fetch(path, { method: 'POST' })
}

// ---------------------------------------------------------------- UI state

let toastTimer = 0
function toast(message, kind = '', ms = 2600) {
  toastEl.textContent = message
  toastEl.className = `toast show ${kind}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast'
  }, ms)
}

function setCursor(cursor) {
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor
}

function updateHoverCursor(p) {
  if (state.space) return setCursor('grab')
  let cursor = TOOLS[state.tool].cursor
  if (state.tool === 'select') {
    const current = selected()
    if (current && hitHandle(current, p)) cursor = 'grab'
    else if (hitTest(p)) cursor = 'move'
  } else if (state.tool === 'eraser' && hitTest(p, false)) {
    cursor = 'pointer'
  }
  setCursor(cursor)
}

function updateUI() {
  const has = !!state.image
  emptyView.hidden = has
  for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool))
  for (const b of swatches) b.setAttribute('aria-checked', String(b.dataset.color === state.color))
  for (const b of sizeButtons) b.setAttribute('aria-checked', String(b.dataset.size === state.size))
  undoBtn.disabled = !state.undo.length
  redoBtn.disabled = !state.redo.length
  clearBtn.disabled = !state.shapes.length
  copyBtn.disabled = !has
  saveBtn.disabled = !has
  attachBtn.disabled = !has || state.busy
  sizeLabel.textContent = has ? `${state.width} × ${state.height}` : 'No image'
  hintLabel.textContent = has ? TOOLS[state.tool].hint : `Paste a screenshot with ${MOD}V. ${snipHint()}`
  updateZoomLabel()
  if (!state.gesture) setCursor(TOOLS[state.tool].cursor)
}

// ---------------------------------------------------------------- pointer

canvas.addEventListener('pointerdown', e => {
  if (!state.image || state.busy) return
  if (state.editing) {
    commitTextEdit()
    if (state.tool !== 'text') return
  }
  if (e.button !== 0 && e.button !== 1) return
  const p = toImage(e)
  canvas.setPointerCapture(e.pointerId)
  // The canvas takes no focus, so a note being typed would keep it.
  if (isTyping(document.activeElement) && document.activeElement !== textEditor) document.activeElement.blur()

  if (e.button === 1 || state.space) {
    state.gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y }
    setCursor('grabbing')
    return
  }

  switch (state.tool) {
    case 'select': {
      const current = selected()
      const handle = current && hitHandle(current, p)
      if (handle) {
        normalizeBox(current)
        state.gesture = { kind: 'handle', id: current.id, handle: handle.key, pushed: false }
        break
      }
      const hit = hitTest(p)
      state.selectedId = hit ? hit.id : null
      if (hit) state.gesture = { kind: 'move', id: hit.id, start: p, orig: structuredClone(hit), pushed: false }
      updateUI()
      break
    }
    case 'pen':
    case 'highlighter':
      state.draft = newShape(state.tool, { points: [[p.x, p.y]] })
      state.gesture = { kind: 'draw' }
      break
    case 'arrow':
    case 'rect':
    case 'ellipse':
      state.draft = newShape(state.tool, { x1: p.x, y1: p.y, x2: p.x, y2: p.y })
      state.gesture = { kind: 'draw' }
      break
    case 'text': {
      const hit = hitTest(p, false)
      if (hit && hit.type === 'text') {
        beginTextEdit(hit, false)
      } else {
        const fs = fontSizeFor(state.size)
        beginTextEdit(newShape('text', { x: p.x, y: p.y - fs * 0.625, text: '' }), true)
      }
      break
    }
    case 'marker': {
      // A press on a marker drags it; anywhere else places a new one,
      // which can still be dragged into place before the button comes up.
      const hit = hitTest(p, false)
      const marker = hit && hit.type === 'marker' ? hit : placeMarker(p)
      state.gesture = {
        kind: 'move',
        id: marker.id,
        start: p,
        orig: structuredClone(marker),
        pushed: marker !== hit,
        focusNote: marker.id,
      }
      break
    }
    case 'crop': {
      const q = clampPoint(p)
      state.crop = { x1: q.x, y1: q.y, x2: q.x, y2: q.y }
      cropBar.hidden = true
      state.gesture = { kind: 'crop' }
      break
    }
    case 'eraser':
      state.gesture = { kind: 'erase', changed: false }
      eraseAt(p)
      break
  }
  render()
})

canvas.addEventListener('pointermove', e => {
  if (!state.image) return
  const p = toImage(e)
  const g = state.gesture
  if (!g) {
    updateHoverCursor(p)
    return
  }
  switch (g.kind) {
    case 'pan':
      state.view.x = g.vx + e.clientX - g.sx
      state.view.y = g.vy + e.clientY - g.sy
      state.view.fitted = false
      clampView()
      positionTextEditor()
      break
    case 'draw':
      updateDraft(p, e.shiftKey)
      break
    case 'move': {
      const s = byId(g.id)
      if (!s) break
      const dx = p.x - g.start.x
      const dy = p.y - g.start.y
      if (!g.pushed) {
        if (Math.hypot(dx, dy) * state.view.scale < 2) break
        pushHistory()
        g.pushed = true
      }
      Object.assign(s, structuredClone(g.orig))
      translate(s, dx, dy)
      break
    }
    case 'handle': {
      const s = byId(g.id)
      if (!s) break
      if (!g.pushed) {
        pushHistory()
        g.pushed = true
      }
      applyHandle(s, g.handle, p)
      break
    }
    case 'crop': {
      const q = clampPoint(p)
      state.crop.x2 = q.x
      state.crop.y2 = q.y
      break
    }
    case 'erase':
      eraseAt(p)
      break
  }
  render()
})

function endGesture(e) {
  const g = state.gesture
  state.gesture = null
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  if (!g) return
  if (g.kind === 'draw') finishDraft()
  else if (g.kind === 'crop') finishCropDrag()
  else if (g.kind === 'handle') {
    const s = byId(g.id)
    if (s) normalizeBox(s)
    afterChange()
  } else if (g.pushed || g.changed) afterChange()
  updateHoverCursor(toImage(e))
  render()
  // After the press, so the browser's own focus handling is already done.
  if (g.focusNote !== undefined) focusNote(g.focusNote)
}

canvas.addEventListener('pointerup', endGesture)
canvas.addEventListener('pointercancel', endGesture)

canvas.addEventListener('dblclick', e => {
  if (!state.image) return
  const hit = hitTest(toImage(e))
  if (!hit) return
  if (hit.type === 'text') beginTextEdit(hit, false)
  else if (hit.type === 'marker') focusNote(hit.id)
})

canvas.addEventListener(
  'wheel',
  e => {
    if (!state.image) return
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY)
      return
    }
    state.view.x -= e.shiftKey ? e.deltaY : e.deltaX
    state.view.y -= e.shiftKey ? 0 : e.deltaY
    state.view.fitted = false
    clampView()
    positionTextEditor()
    render()
  },
  { passive: false },
)

canvas.addEventListener('pointerleave', () => {
  if (!state.gesture) setCursor(TOOLS[state.tool].cursor)
})

// ---------------------------------------------------------------- keyboard

const isTyping = target =>
  target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)

// Shortcuts follow the physical key, so Ctrl+Z, the tool letters and [ ] work
// in any keyboard layout (on a Russian layout the Z key types "я").
const CODE_KEYS = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', NumpadAdd: '+', NumpadSubtract: '-' }

function shortcutKey(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (/^(Digit|Numpad)[0-9]$/.test(e.code)) return e.code.slice(-1)
  if (CODE_KEYS[e.code]) return CODE_KEYS[e.code]
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

// What each field held when it got the focus: a note nobody has typed in yet
// hands Ctrl+Z to the picture, so placing a marker can be undone at once.
const valueAtFocus = new WeakMap()
document.addEventListener('focusin', e => {
  if (e.target instanceof HTMLTextAreaElement) valueAtFocus.set(e.target, e.target.value)
})

function nudge(dx, dy) {
  const s = selected()
  if (!s) return false
  pushHistory()
  translate(s, dx, dy)
  afterChange()
  return true
}

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey
  const key = shortcutKey(e)

  if (mod && key === 'Enter') {
    e.preventDefault()
    attach()
    return
  }
  if (isTyping(e.target)) {
    const isUndo = mod && (key === 'z' || key === 'y')
    const untouched = e.target !== textEditor && e.target.value === valueAtFocus.get(e.target)
    if (isUndo && untouched && doneView.hidden) {
      e.preventDefault()
      e.target.blur()
      if (key === 'z' && !e.shiftKey) undo()
      else redo()
    }
    return
  }
  if (!doneView.hidden) return

  if (mod) {
    if (key === 'z' && !e.shiftKey) undo()
    else if (key === 'y' || (key === 'z' && e.shiftKey)) redo()
    else if (key === 'c') {
      if (window.getSelection()?.toString()) return
      copyImage()
    } else if (key === 's') saveImage()
    else if (key === 'o') fileInput.click()
    else if (key === '0') fitView()
    else if (key === '=' || key === '+') zoomCenter(1.25)
    else if (key === '-') zoomCenter(0.8)
    else return
    e.preventDefault()
    return
  }
  if (e.altKey) return

  switch (key) {
    case 'Delete':
    case 'Backspace':
      if (state.selectedId !== null) {
        e.preventDefault()
        removeShape(state.selectedId)
      }
      return
    case 'Escape':
      if (state.crop) cancelCrop()
      else if (state.selectedId !== null) {
        state.selectedId = null
        updateUI()
        render()
      }
      return
    case 'Enter':
      if (state.crop && !cropBar.hidden) {
        e.preventDefault()
        applyCrop()
      }
      return
    case ' ':
      e.preventDefault()
      if (!state.space) {
        state.space = true
        setCursor('grab')
      }
      return
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const step = (e.shiftKey ? 10 : 1) / Math.max(state.view.scale, 0.0001)
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
      if (nudge(dx, dy)) e.preventDefault()
      return
    }
    case '[':
      cycleSize(-1)
      return
    case ']':
      cycleSize(1)
      return
  }
  if (/^[1-8]$/.test(key)) {
    setColor(COLORS[Number(key) - 1].value)
    return
  }
  const tool = TOOL_BY_KEY[key]
  if (tool && state.image) {
    e.preventDefault()
    setTool(tool)
  }
})

window.addEventListener('keyup', e => {
  if (e.key === ' ' || e.code === 'Space') {
    state.space = false
    if (!state.gesture) setCursor(TOOLS[state.tool].cursor)
  }
})

textEditor.addEventListener('input', positionTextEditor)
textEditor.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault()
    commitTextEdit()
  }
})
textEditor.addEventListener('blur', () => {
  // A press on the toolbar keeps the focus (see below), so a blur means done.
  commitTextEdit()
})

// ---------------------------------------------------------------- input sources

window.addEventListener('paste', e => {
  const items = [...(e.clipboardData?.items || [])]
  const image = items.find(item => item.kind === 'file' && item.type.startsWith('image/'))
  const hasText = items.some(item => item.type === 'text/plain')
  if (image && (!isTyping(e.target) || !hasText)) {
    e.preventDefault()
    loadImageBlob(image.getAsFile())
    return
  }
  if (!isTyping(e.target) && !image) toast(`The clipboard holds no image. ${snipHint()}`)
})

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
let dragDepth = 0
window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  wrap.classList.add('dropping')
})
window.addEventListener('dragover', e => {
  if (hasFiles(e)) e.preventDefault()
})
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) wrap.classList.remove('dropping')
})
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  wrap.classList.remove('dropping')
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'))
  if (file) loadImageBlob(file)
  else toast('Drop an image file (PNG, JPG, WebP, GIF or BMP).', 'error')
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0]
  fileInput.value = ''
  if (file) loadImageBlob(file)
})

window.addEventListener('beforeunload', e => {
  if (state.image && (state.shapes.length || hasNotes()) && !state.used) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ---------------------------------------------------------------- wiring

function init() {
  byIdEl('paste-key').textContent = `${MOD}V`
  if (isMac) {
    byIdEl('snip-tip').innerHTML = 'Tip: <kbd>⌘</kbd>+<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>4</kbd> copies part of your screen.'
  }

  for (const b of toolButtons) {
    const tool = TOOLS[b.dataset.tool]
    b.title = `${tool.name} (${tool.key.toUpperCase()})`
    b.addEventListener('click', () => setTool(b.dataset.tool))
  }

  const colorsEl = byIdEl('colors')
  COLORS.forEach((c, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'swatch'
    b.dataset.color = c.value
    b.style.background = c.value
    b.title = `${c.name} (${i + 1})`
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-label', c.name)
    b.addEventListener('click', () => setColor(c.value))
    colorsEl.append(b)
    swatches.push(b)
  })

  for (const b of sizeButtons) {
    b.title = `${SIZE_NAMES[b.dataset.size]} ([ and ] switch)`
    b.addEventListener('click', () => setSize(b.dataset.size))
  }

  // Toolbar presses keep the focus where it is, so a label being typed
  // takes a new color or size instead of being closed by the click.
  document.querySelector('.toolbar').addEventListener('mousedown', e => {
    if (e.target.closest('button')) e.preventDefault()
  })

  undoBtn.title = `Undo (${MOD}Z)`
  redoBtn.title = isMac ? 'Redo (⌘⇧Z)' : 'Redo (Ctrl+Y)'
  clearBtn.title = 'Remove all marks'
  byIdEl('open').title = `Open an image (${MOD}O)`
  copyBtn.title = `Copy the marked-up image, then paste it into Claude with ${MOD}V (${MOD}C)`
  saveBtn.title = `Save a copy on this computer (${MOD}S)`
  attachBtn.title = `Attach to your next message in Claude (${MOD}Enter)`
  byIdEl('zoom-in').title = `Zoom in (${MOD}+)`
  byIdEl('zoom-out').title = `Zoom out (${MOD}-)`
  byIdEl('zoom-fit').title = `Fit to window (${MOD}0)`

  undoBtn.addEventListener('click', undo)
  redoBtn.addEventListener('click', redo)
  clearBtn.addEventListener('click', clearMarks)
  byIdEl('open').addEventListener('click', () => fileInput.click())
  byIdEl('open-btn').addEventListener('click', () => fileInput.click())
  byIdEl('paste-btn').addEventListener('click', pasteFromClipboard)
  copyBtn.addEventListener('click', copyImage)
  saveBtn.addEventListener('click', saveImage)
  attachBtn.addEventListener('click', attach)
  byIdEl('crop-apply').addEventListener('click', applyCrop)
  byIdEl('crop-cancel').addEventListener('click', cancelCrop)
  byIdEl('zoom-in').addEventListener('click', () => zoomCenter(1.25))
  byIdEl('zoom-out').addEventListener('click', () => zoomCenter(0.8))
  byIdEl('zoom-fit').addEventListener('click', fitView)
  byIdEl('another').addEventListener('click', resetDocument)
  byIdEl('close-window').addEventListener('click', () => {
    window.close()
    setTimeout(() => toast('You can close this window now.'), 300)
  })
  byIdEl('reveal').addEventListener('click', async () => {
    try {
      const response = await api('api/reveal')
      if (!response.ok) throw new Error()
    } catch {
      toast('Could not open the folder. Is the Claude session still open?', 'error')
    }
  })

  closeAfterBox.checked = settings.get('closeAfter', true)
  legendBox.checked = settings.get('legend', true)
  closeAfterBox.addEventListener('change', () => settings.set('closeAfter', closeAfterBox.checked))
  autoCopyBox.checked = settings.get('autoCopy', false)
  legendBox.addEventListener('change', () => {
    settings.set('legend', legendBox.checked)
    scheduleAutoCopy()
  })
  autoCopyBox.addEventListener('change', () => {
    settings.set('autoCopy', autoCopyBox.checked)
    scheduleAutoCopy()
  })
  commentField.addEventListener('input', () => {
    state.used = false
    autoGrow(commentField)
    scheduleAutoCopy()
  })

  new ResizeObserver(() => {
    resizeCanvas()
    if (state.image) {
      if (state.view.fitted) fitView()
      else clampView()
    }
    positionTextEditor()
    render()
  }).observe(wrap)

  resizeCanvas()
  renderNotes()
  updateUI()
  render()
  loadClipboardOnStart()

  // Keeps the helper alive while this window is open.
  const ping = () => fetch('api/ping').catch(() => {})
  ping()
  setInterval(ping, 60000)
}

init()

// Hooks for automated checks of the editor (no effect on normal use).
window.__qsketch = { state, loadImageBlob, exportCanvas, setTool, attach, noteEntries }
