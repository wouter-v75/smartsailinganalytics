// src/lib/xlsxRead.ts
// ─────────────────────────────────────────────────────────────────────────────
// Minimal .xlsx reader: cell VALUES only (no styles, formulas or dates), enough
// to import tables such as a polar workbook without shipping a spreadsheet
// library. An .xlsx is a zip of XML parts; entries are stored or deflated, and
// deflate is undone with the platform DecompressionStream (browsers, Node 18+).
// Cached formula results are read like any other value. ZIP64 is not supported.
// ─────────────────────────────────────────────────────────────────────────────

export interface XlsxSheet {
  name: string
  rows: string[][]   // rows[r][c], '' for empty cells; row/column positions kept
}

interface ZipEntry { method: number; size: number; offset: number }

function zipEntries(buf: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = buf.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory)')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = new Map<string, ZipEntry>()
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory')
    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    out.set(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)), { method, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  const written = writer.write(data).then(() => writer.close())
  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await written
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

async function readPart(buf: Uint8Array, entries: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const e = entries.get(name)
  if (!e) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true)
  const raw = buf.subarray(start, start + e.size)
  const bytes = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null
  if (!bytes) throw new Error(`unsupported zip compression (${e.method}) in ${name}`)
  return new TextDecoder().decode(bytes)
}

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, k: string) => {
    const lk = k.toLowerCase()
    if (lk === 'lt') return '<'
    if (lk === 'gt') return '>'
    if (lk === 'quot') return '"'
    if (lk === 'apos') return "'"
    if (lk === 'amp') return '&'
    return String.fromCodePoint(lk[1] === 'x' ? parseInt(lk.slice(2), 16) : parseInt(lk.slice(1), 10))
  })

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null
const texts = (xml: string) => Array.from(xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), m => decodeXml(m[1])).join('')

function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref.match(/^[A-Z]+/)?.[0] || 'A') n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  let next = 0
  for (const rm of Array.from(xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g))) {
    const r = Number(attr(rm[1], 'r')) - 1
    const ri = Number.isFinite(r) && r >= 0 ? r : next
    next = ri + 1
    const cells: string[] = []
    for (const cm of Array.from((rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g))) {
      const ref = attr(cm[1], 'r')
      const ci = ref ? colIndex(ref) : cells.length
      const t = attr(cm[1], 't')
      const body = cm[2] || ''
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let val = ''
      if (t === 's') val = v != null ? shared[Number(v)] ?? '' : ''
      else if (t === 'inlineStr') val = texts(body)
      else if (v != null) val = decodeXml(v)
      cells[ci] = val
    }
    rows[ri] = Array.from(cells, c => c ?? '')
  }
  return Array.from(rows, r => r ?? [])
}

export async function readXlsx(input: ArrayBuffer | Uint8Array): Promise<XlsxSheet[]> {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  const entries = zipEntries(buf)
  const workbook = await readPart(buf, entries, 'xl/workbook.xml')
  if (!workbook) throw new Error('not an .xlsx file (no workbook)')

  const sharedXml = await readPart(buf, entries, 'xl/sharedStrings.xml')
  const shared = sharedXml
    ? Array.from(sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), m => texts(m[1]))
    : []

  const relsXml = (await readPart(buf, entries, 'xl/_rels/workbook.xml.rels')) || ''
  const targets = new Map<string, string>()
  for (const m of Array.from(relsXml.matchAll(/<Relationship\b[^>]*>/g))) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target')
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }

  const sheets: XlsxSheet[] = []
  for (const m of Array.from(workbook.matchAll(/<sheet\b[^>]*>/g))) {
    const name = decodeXml(attr(m[0], 'name') || '')
    const path = targets.get(attr(m[0], 'r:id') || '')
    const xml = path ? await readPart(buf, entries, path) : null
    if (xml) sheets.push({ name, rows: parseSheet(xml, shared) })
  }
  return sheets
}
