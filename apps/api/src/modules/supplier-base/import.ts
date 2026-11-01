import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { CategoryCodeSchema, NameSchema, RegionCodeSchema, ShortTextSchema, TextSchema } from '../../deps/contracts.js';
import { CounterpartyIdentifierSchema, SupplierStatusSchema } from './deps.js';

/**
 * Supplier import from CSV or XLSX (PRC-003 step 4). A file is untrusted data: cells are parsed as text, never
 * evaluated, never followed (no formulas, links or external references are read) and never issue commands. Every row
 * becomes, at most, one private external counterparty and one private supplier record of the importing company: an
 * import never creates a directory member, a company, a claim, a handle or any public record (INTEG-001 rule).
 *
 * Template (header row, case-insensitive, any column order; unknown columns are refused so a typo is not silently
 * dropped): `name` (required), `identifier_kind`, `identifier_value` (a country-pack identifier such as `us_ein`),
 * `email`, `phone`, `categories` and `regions` (separated by `;`), `status` (default `prospect`), `payment_terms`,
 * `notes`.
 */
export const IMPORT_COLUMNS = ['name', 'identifier_kind', 'identifier_value', 'email', 'phone', 'categories', 'regions', 'status', 'payment_terms', 'notes'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export const MAX_IMPORT_ROWS = 1000;
export const IMPORT_TEMPLATE_CSV = `${IMPORT_COLUMNS.join(',')}\nSynthetic Lumber Supply LLC,us_ein,00-0000000,orders@example.invalid,,lumber;framing,US-TX;US-OK,approved,Net 30,Synthetic example row\n`;

export const SupplierImportRowSchema = z.strictObject({
  rowNumber: z.int().min(2),
  name: NameSchema,
  identifiers: z.array(CounterpartyIdentifierSchema).max(1),
  contacts: z.array(z.strictObject({ role: z.string().min(1).max(80), channel: z.enum(['email', 'phone']), value: z.string().min(1).max(300) })).max(2),
  categories: z.array(CategoryCodeSchema).max(50),
  regions: z.array(RegionCodeSchema).max(50),
  status: SupplierStatusSchema,
  defaultPaymentTerms: ShortTextSchema.nullable(),
  internalNotes: TextSchema.nullable(),
});
export type SupplierImportRow = z.infer<typeof SupplierImportRowSchema>;
export interface ImportRowError { rowNumber: number; column: string; code: string }

export class ImportFileError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ImportFileError';
  }
}

/* ---------- CSV (RFC 4180) ---------- */

/** Rows of a CSV text: quoted fields with doubled quotes, commas, CR LF or LF line ends, a leading byte-order mark. */
export function parseCsv(text: string, maxRows = MAX_IMPORT_ROWS + 1): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new ImportFileError('too_many_rows');
  };
  while (i < input.length) {
    const c = input[i] as string;
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && input[i + 1] === '\n') {
      endRow();
      i += 1;
    } else if (c === '\n' || c === '\r') {
      endRow();
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new ImportFileError('unterminated_quote');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/* ---------- XLSX (Office Open XML, first worksheet, values only) ---------- */

const MAX_XLSX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 200;

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number; flags: number }

/** Central directory of a ZIP archive (no ZIP64, no encryption, no multi-disk archives: all refused). */
function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportFileError('not_a_workbook');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_XLSX_ENTRIES || cdOffset >= buf.length) throw new ImportFileError('not_a_workbook');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ImportFileError('not_a_workbook');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if ((flags & 0x1) !== 0) throw new ImportFileError('encrypted_workbook');
    entries.set(name, { name, method, compressedSize, size, offset, flags });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipRead(buf: Buffer, entry: ZipEntry): string {
  if (entry.size > MAX_XLSX_ENTRY_BYTES || entry.offset + 30 > buf.length || buf.readUInt32LE(entry.offset) !== 0x04034b50) throw new ImportFileError('not_a_workbook');
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  let out: Buffer;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: MAX_XLSX_ENTRY_BYTES });
    } catch {
      throw new ImportFileError('not_a_workbook');
    }
  } else throw new ImportFileError('not_a_workbook');
  if (out.length !== entry.size) throw new ImportFileError('not_a_workbook');
  return out.toString('utf8');
}

function xmlText(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
/** Concatenated `<t>` runs of a shared string or an inline string (rich text runs included, phonetic runs skipped). */
function runsText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) text += xmlText(m[1] ?? '');
  return text;
}
const columnIndex = (ref: string): number => {
  const letters = /^([A-Z]{1,3})/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Rows of the first worksheet as text. Formulas contribute their cached value only; they are never evaluated. */
export function parseXlsx(buf: Buffer, maxRows = MAX_IMPORT_ROWS + 1): string[][] {
  const entries = zipEntries(buf);
  const read = (name: string): string | null => {
    const e = entries.get(name);
    return e ? zipRead(buf, e) : null;
  };
  // The first sheet in workbook order, through the workbook relationships; sheet1.xml when they are absent.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
    const rel = rid ? new RegExp(`<Relationship\\b[^>]*\\bId="${rid.replace(/[^A-Za-z0-9]/g, '')}"[^>]*>`).exec(rels)?.[0] : undefined;
    const target = rel ? /\bTarget="([^"]+)"/.exec(rel)?.[1] : undefined;
    if (target && !/^[a-z]+:/i.test(target) && !target.includes('..')) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const sheet = read(sheetPath);
  if (sheet === null) throw new ImportFileError('not_a_workbook');
  const sharedXml = read('xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1] ?? '')) : [];
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+[0-9]+)"/.exec(attrs)?.[1];
      const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? 'n';
      const index = ref ? columnIndex(ref) : cells.length;
      if (index < 0 || index > 100) throw new ImportFileError('too_many_columns');
      let value = '';
      if (type === 'inlineStr') value = runsText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number.parseInt(v, 10)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else value = xmlText(v);
        }
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (cells.every((x) => x.trim() === '')) continue;
    rows.push(cells);
    if (rows.length > maxRows) throw new ImportFileError('too_many_rows');
  }
  return rows;
}

/* ---------- Rows ---------- */

// Control characters other than tab and line ends are dropped from cells (they are data, but never invisible).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string | undefined): string => (s ?? '').replace(CONTROL, '').trim();
const list = (s: string): string[] => s.split(';').map((x) => x.trim()).filter((x) => x !== '');

/** Maps a parsed table (header first) to validated rows, or row errors. Nothing is written here. */
export function mapImportRows(table: string[][]): { rows: SupplierImportRow[]; errors: ImportRowError[] } {
  const errors: ImportRowError[] = [];
  const [header, ...body] = table;
  if (!header) return { rows: [], errors: [{ rowNumber: 1, column: 'name', code: 'import.header_missing' }] };
  const names = header.map((h) => clean(h).toLowerCase());
  names.forEach((n, i) => {
    if (n === '' && body.every((r) => clean(r[i]) === '')) return;
    if (!(IMPORT_COLUMNS as readonly string[]).includes(n)) errors.push({ rowNumber: 1, column: n || `column_${i + 1}`, code: 'import.unknown_column' });
    else if (names.indexOf(n) !== i) errors.push({ rowNumber: 1, column: n, code: 'import.duplicate_column' });
  });
  if (!names.includes('name')) errors.push({ rowNumber: 1, column: 'name', code: 'import.column_missing' });
  if (body.length > MAX_IMPORT_ROWS) errors.push({ rowNumber: MAX_IMPORT_ROWS + 2, column: 'name', code: 'import.too_many_rows' });
  if (errors.length > 0) return { rows: [], errors };
  const at = (r: string[], c: ImportColumn): string => {
    const i = names.indexOf(c);
    return i < 0 ? '' : clean(r[i]);
  };
  const rows: SupplierImportRow[] = [];
  const seen = new Map<string, number>();
  body.forEach((r, index) => {
    const rowNumber = index + 2;
    const name = at(r, 'name');
    const idKind = at(r, 'identifier_kind');
    const idValue = at(r, 'identifier_value');
    const email = at(r, 'email');
    const phone = at(r, 'phone');
    const candidate = {
      rowNumber, name,
      identifiers: idKind || idValue ? [{ kind: idKind, value: idValue }] : [],
      contacts: [...(email ? [{ role: 'imported', channel: 'email' as const, value: email }] : []), ...(phone ? [{ role: 'imported', channel: 'phone' as const, value: phone }] : [])],
      categories: list(at(r, 'categories')), regions: list(at(r, 'regions')).map((x) => x.toUpperCase()),
      status: at(r, 'status') || 'prospect', defaultPaymentTerms: at(r, 'payment_terms') || null, internalNotes: at(r, 'notes') || null,
    };
    const parsed = SupplierImportRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const columnOf: Record<string, ImportColumn> = {
        name: 'name', identifiers: 'identifier_kind', contacts: 'email', categories: 'categories', regions: 'regions', status: 'status', defaultPaymentTerms: 'payment_terms', internalNotes: 'notes',
      };
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'name');
        const column = field === 'identifiers' && String(issue.path[2] ?? '') === 'value' ? 'identifier_value' : columnOf[field] ?? 'name';
        if (!errors.some((e) => e.rowNumber === rowNumber && e.column === column)) errors.push({ rowNumber, column, code: 'import.invalid_value' });
      }
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ rowNumber, column: 'email', code: 'import.invalid_value' });
      return;
    }
    const key = nameKey(parsed.data.name);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ rowNumber, column: 'name', code: 'import.duplicate_name' });
      return;
    }
    seen.set(key, rowNumber);
    rows.push(parsed.data);
  });
  return { rows, errors };
}

/** The database's `external_counterparty.name_key`: lower case, inner white space collapsed. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Decodes the uploaded file into a table; throws ImportFileError for an unreadable file. */
export function readImportFile(file: { format: 'csv'; text: string } | { format: 'xlsx'; base64: string }): string[][] {
  if (file.format === 'csv') return parseCsv(file.text);
  const buf = Buffer.from(file.base64.replace(/\s+/g, ''), 'base64');
  if (buf.length < 22) throw new ImportFileError('not_a_workbook');
  return parseXlsx(buf);
}
