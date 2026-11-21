// Desktop drawings in the look of the savvy-progress agents panel: one SVG per
// row, so the desktop never wraps parts of a row onto a new line. Pure strings.

import type { Status } from '../types'

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
export const ACCENT = '#8f8cf4'
export const DONE = '#5fbf8f'
export const OK = '#3B9C5F'
export const FAIL = '#D0453F'
export const BLUE = '#378ADD'
export const GREY = '#888780'

export const ROW_H = 58
export const SUB_H = 16

const CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tile{fill:#f1efe8}.ln{stroke:#e4e4e2;stroke-width:1}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a3a3a0}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tile{fill:#262624}.ln{stroke:#2f2f2d}}
.live{animation:pl 1.4s ease-in-out infinite}@keyframes pl{50%{opacity:.3}}
.tw{animation:tw 2.2s ease-in-out infinite}@keyframes tw{50%{opacity:.35}}
.run .la{animation:la .5s steps(1) infinite}.run .lb{animation:la .5s steps(1) infinite;animation-delay:-.25s}
@keyframes la{50%{transform:translateY(-1px)}}
@media (prefers-reduced-motion: reduce){.live,.tw,.run .la,.run .lb{animation:none}}
</style>`

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿！-｠\u{1F300}-\u{1FAFF}]/u

// Rough advance of system UI text, in em; good enough to cut a title in time.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZÄÖÜmw@%]/.test(ch) ? 0.72 : 0.56

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

export const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`

const text = (x: number, y: number, size: number, cls: string, s: string, extra = ''): string =>
  `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${extra}>${xml(s)}</text>`

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The goal bar: dithered pixels, sparse at the start and dense toward the head,
// with a pill that carries the count.
export const ditherBar = (W: number, H: number, ratio: number, color: string, label: string): string => {
  const r = Math.min(1, Math.max(0, ratio))
  const fillW = Math.round(W * r)
  const cols = Math.floor(fillW / 3)
  const rows = Math.floor(H / 3)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let y = 0; y < rows; y++) {
      if (noise(c, y) < density) {
        const delay = (noise(y, c) * 2).toFixed(2)
        dots.push(`<rect class="tw" style="animation-delay:-${delay}s" x="${c * 3 + 1}" y="${y * 3 + 1}" width="2" height="2"/>`)
      }
    }
  }
  const pillW = Math.round(18 + label.length * 6.6)
  const pillX = Math.max(0, Math.min(W - pillW, fillW - pillW))
  return `<defs><clipPath id="gb"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath></defs>
<rect class="k" width="${W}" height="${H}" rx="${H / 2}"/>
<g clip-path="url(#gb)" fill="${color}">${dots.join('')}</g>
<rect x="${pillX}" width="${pillW}" height="${H}" rx="${H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(label)}</text>`
}

// A small pixel crab, 30×24, in the row's color. Walking crabs move their legs.
export const crab = (x: number, y: number, color: string, opts: { isDim?: boolean; isWalking?: boolean } = {}): string => {
  const body = [
    [6, 6, 18, 9],
    [4, 9, 3, 3],
    [23, 9, 3, 3],
    [2, 5, 4, 3],
    [24, 5, 4, 3],
  ]
    .map(([bx, by, w, h]) => `<rect x="${bx}" y="${by}" width="${w}" height="${h}" fill="${color}"/>`)
    .join('')
  const eyes = `<rect x="10" y="8" width="2" height="2" fill="#ffffff"/><rect x="18" y="8" width="2" height="2" fill="#ffffff"/>`
  const legs = (xs: number[], cls: string) =>
    `<g class="${cls}">${xs.map(lx => `<rect x="${lx}" y="15" width="2" height="4" fill="${color}"/>`).join('')}</g>`
  return `<g transform="translate(${x},${y})" opacity="${opts.isDim ? 0.45 : 1}" shape-rendering="crispEdges"><g${opts.isWalking ? ' class="run"' : ''}>${body}${eyes}${legs([8, 17], 'la')}${legs([12, 21], 'lb')}</g></g>`
}

// A terminal glyph for Bash rows and gates, 30×24.
export const shell = (x: number, y: number, color: string): string =>
  `<g transform="translate(${x},${y})"><rect x="3" y="3" width="24" height="18" rx="4" fill="none" stroke="${color}" stroke-width="1.6"/><path d="M8 9l3.5 3-3.5 3" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 15.5h6" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/></g>`

export type Mark = 'running' | 'done' | 'failed' | 'pending' | 'skipped'

export const statusMark = (x: number, y: number, status: Mark, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done')
    return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${OK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${FAIL}" stroke-width="1.8" stroke-linecap="round"/>`
  if (status === 'skipped') return `<path d="M${x - 4} ${y}h8" stroke="#9a9a96" stroke-width="1.6" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

export const markOf = (s: Status): Mark => (s === 'in_progress' ? 'running' : s)

// --- the header: title, goal bar and three tiles -------------------------------

export type Tile = { label: string; value: string }

export const headerHeight = (title: string, hasBar: boolean): number => (title ? 24 : 0) + (hasBar ? 26 : 0) + 44

export const headerSvg = (W: number, title: string, bar: { ratio: number; label: string; color: string } | null, tiles: readonly Tile[]): string => {
  const gap = 6
  const n = Math.max(1, tiles.length)
  const tw = (W - gap * (n - 1)) / n
  let y = 0
  let body = ''
  if (title) {
    body += text(0, 15, 14, 't', fitText(title, 14, W), ' font-weight="600"')
    y = 24
  }
  if (bar) {
    body += `<g transform="translate(0,${y})">${ditherBar(W, 16, bar.ratio, bar.color, bar.label)}</g>`
    y += 26
  }
  tiles.forEach((tile, i) => {
    const x = i * (tw + gap)
    body += `<rect class="tile" x="${x}" y="${y}" width="${tw}" height="40" rx="8"/>`
    body += text(x + 9, y + 16, 11, 's', fitText(tile.label, 11, tw - 14))
    body += text(x + 9, y + 33, 15, 't', fitText(tile.value, 15, tw - 14), ' font-weight="600" font-variant-numeric="tabular-nums"')
  })
  return svg(W, headerHeight(title, bar !== null), body)
}

// --- one row: icon, title, a coloured word with meta, optional bar and lines ---

export type Row = {
  icon: 'crab' | 'shell'
  color: string
  title: string
  word: string
  wordColor: string
  meta: string
  mark: Mark
  isDim?: boolean
  isWalking?: boolean
  /** 0..1 draws a thin bar under the meta; `grey` draws it in grey. */
  bar?: { ratio: number; isGrey?: boolean }
  /** Right-aligned under the bar, e.g. "1:12 / ~2:05". */
  stats?: string
  /** Left under the bar, e.g. the command. */
  note?: string
  /** Lines below, one per sub step: glyph colour, text, dim. */
  lines?: readonly { mark: Mark; color: string; text: string; isDim?: boolean }[]
}

export const rowHeight = (r: Row): number => {
  const base = r.bar ? ROW_H + (r.stats || r.note ? 14 : 0) : 44
  return base + (r.lines?.length ?? 0) * SUB_H + (r.lines?.length ? 4 : 0)
}

export const rowSvg = (W: number, r: Row): string => {
  const H = rowHeight(r)
  const X = 42
  const textW = W - X - 22
  const icon = r.icon === 'crab' ? crab(0, 7, r.color, { isDim: r.isDim, isWalking: r.isWalking }) : shell(0, 7, r.isDim ? GREY : r.color)
  let body = `<g opacity="${r.isDim ? 0.55 : 1}">${icon}`
  body += text(X, 18, 13, r.isDim ? 's' : 't', fitText(r.title, 13, textW), ' font-weight="600"')
  body += `<text x="${X}" y="34" font-family="${FONT}" font-size="11"><tspan fill="${r.wordColor}">${xml(r.word)}</tspan><tspan class="s">${xml(fitText(r.meta ? `  ·  ${r.meta}` : '', 11, Math.max(20, textW - textWidth(r.word, 11))))}</tspan></text>`
  let y = 34
  if (r.bar) {
    const ratio = Math.min(1, Math.max(0, r.bar.ratio))
    const fillW = Math.round(textW * ratio)
    body += `<rect class="k" x="${X}" y="42" width="${textW}" height="4" rx="2"/>`
    body += `<rect${r.bar.isGrey ? ' class="m"' : ''} x="${X}" y="42" width="${fillW}" height="4" rx="2"${r.bar.isGrey ? '' : ` fill="${r.color}"`}/>`
    y = 46
    if (r.stats || r.note) {
      y = 60
      const statsW = r.stats ? textWidth(r.stats, 11) : 0
      if (r.note) body += text(X, y, 11, 'm', fitText(r.note, 11, Math.max(20, textW - statsW - 12)))
      if (r.stats) body += text(X + textW, y, 11, 's', r.stats, ' text-anchor="end" font-variant-numeric="tabular-nums"')
    }
  }
  for (const line of r.lines ?? []) {
    y += SUB_H
    body += statusMark(X + 6, y - 4, line.mark, line.color).replace(/stroke-width="1\.8"/g, 'stroke-width="1.5"').replace(/r="3\.5"/, 'r="3"')
    body += text(X + 18, y, 11, line.isDim ? 'm' : 's', fitText(line.text, 11, textW - 18))
  }
  body += `</g>${statusMark(W - 8, 16, r.mark, r.color)}<line class="ln" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`
  return svg(W, H, body)
}
