import { makeZip, readZip } from './zip';

export type Cell = string | number | boolean | null | undefined;
export type Sheet = { name: string; rows: Cell[][] };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);

// ---------- CSV ----------
export function toCsv(rows: Cell[][], sep = ';'): string {
  const esc = (c: Cell) => {
    const s = c == null ? '' : String(c);
    return /["\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM agar Excel membaca UTF-8; pemisah ";" cocok untuk Excel berlokal Indonesia.
  return '\uFEFF' + rows.map((r) => r.map(esc).join(sep)).join('\r\n');
}

export function downloadCsv(filename: string, rows: Cell[][]) {
  downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), filename);
}

/** Parser CSV sederhana; mendeteksi pemisah ; , atau tab dari baris pertama. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------- XLSX (tulis) ----------
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: Cell[][]) {
  const widths: number[] = [];
  rows.forEach((r) => r.forEach((c, i) => { widths[i] = Math.min(60, Math.max(widths[i] || 8, String(c ?? '').length + 2)); }));
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (c == null || c === '') return '';
      const style = ri === 0 ? ' s="1"' : '';
      if (typeof c === 'number' && Number.isFinite(c)) return `<c r="${ref}"${style}><v>${c}</v></c>`;
      if (typeof c === 'boolean') return `<c r="${ref}" t="b"${style}><v>${c ? 1 : 0}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(String(c))}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

export function makeXlsx(sheets: Sheet[]): Uint8Array {
  const safe = sheets.map((s, i) => ({ ...s, name: (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) }));
  const files = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF14213D"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>` },
    ...safe.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) })),
  ];
  return makeZip(files.map((f) => ({ name: f.name, data: enc.encode(f.text) })));
}

export function downloadXlsx(filename: string, sheets: Sheet[]) {
  downloadBlob(new Blob([makeXlsx(sheets) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

// ---------- XLSX (baca) ----------
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const textOf = (xml: string) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

/** Membaca sheet pertama berkas .xlsx menjadi baris-baris teks. */
export async function readXlsx(data: Uint8Array): Promise<string[][]> {
  const files = await readZip(data);
  const sstXml = files.get('xl/sharedStrings.xml');
  const shared = sstXml ? [...dec.decode(sstXml).matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const wb = dec.decode(files.get('xl/workbook.xml') || new Uint8Array());
  const rels = dec.decode(files.get('xl/_rels/workbook.xml.rels') || new Uint8Array());
  const rid = wb.match(/<sheet [^>]*r:id="([^"]+)"/)?.[1];
  let target = rid ? rels.match(new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*>`))?.[0].match(/Target="([^"]+)"/)?.[1] : undefined;
  if (target) target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = files.get(target || 'xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Sheet pertama tidak ditemukan di berkas Excel.');
  const rows: string[][] = [];
  for (const rm of dec.decode(sheet).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = attrs.match(/r="([A-Z]+[0-9]+)"/)?.[1];
      if (!ref) continue;
      const t = attrs.match(/t="([^"]+)"/)?.[1];
      let v = '';
      if (t === 's') v = shared[Number(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1])] ?? '';
      else if (t === 'inlineStr') v = textOf(inner);
      else v = unxml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      row[colIndex(ref)] = v;
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Membaca berkas .xlsx atau .csv dari input file. */
export async function readTable(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  if (/\.(csv|txt|tsv)$/i.test(file.name)) return parseCsv(await file.text());
  throw new Error('Format harus .xlsx atau .csv.');
}

export function downloadZip(filename: string, entries: { name: string; data: Uint8Array }[]) {
  downloadBlob(new Blob([makeZip(entries) as BlobPart], { type: 'application/zip' }), filename);
}
