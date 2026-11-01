import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { IMPORT_COLUMNS, IMPORT_TEMPLATE_CSV, ImportFileError, mapImportRows, nameKey, parseCsv, parseXlsx, readImportFile } from '../../apps/api/src/modules/supplier-base/import.js';
import { SUPPLIER_BASE_CAPABILITY_OPERATIONS } from '../../apps/api/src/modules/supplier-base/capabilities.js';
import { SUPPLY_CAPABILITIES } from '../../packages/contracts/src/supply/capabilities.js';
import { xlsx, zip } from './helpers.js';

/**
 * PRC-003 step 4 without a database: the CSV and XLSX readers treat a file as data (quotes, line ends, byte-order
 * marks, shared and inline strings, cached formula values, entities), refuse unreadable, encrypted or oversized
 * workbooks, and the row mapper refuses unknown columns, bad values and duplicate names before anything is written.
 */
test('supplier import: CSV reader', () => {
  assert.deepEqual(parseCsv('﻿name,notes\r\n"Synthetic ""A"", Inc","line one\nline two"\r\nSynthetic B,\n\n'), [['name', 'notes'], ['Synthetic "A", Inc', 'line one\nline two'], ['Synthetic B', '']]);
  assert.deepEqual(parseCsv('name\rSynthetic C'), [['name'], ['Synthetic C']]);
  assert.throws(() => parseCsv('name\n"unterminated'), (e: unknown) => e instanceof ImportFileError && e.reason === 'unterminated_quote');
  assert.throws(() => parseCsv(`name\n${'x\n'.repeat(5)}`, 3), (e: unknown) => e instanceof ImportFileError && e.reason === 'too_many_rows');
  // The published template maps without errors.
  const template = mapImportRows(parseCsv(IMPORT_TEMPLATE_CSV));
  assert.deepEqual(template.errors, []);
  assert.equal(template.rows[0]?.name, 'Synthetic Lumber Supply LLC');
  assert.deepEqual(template.rows[0]?.regions, ['US-TX', 'US-OK']);
});

test('supplier import: XLSX reader reads values only and refuses what it cannot read safely', () => {
  const book = xlsx([['name', 'notes'], ['Synthetic Tiles & Stone', '<b>not markup</b>'], ['', ''], ['Synthetic Glass', '']]);
  assert.deepEqual(parseXlsx(book), [['name', 'notes'], ['Synthetic Tiles & Stone', '<b>not markup</b>'], ['Synthetic Glass']]);
  assert.deepEqual(readImportFile({ format: 'xlsx', base64: book.toString('base64') }), parseXlsx(book));
  // A formula contributes its cached value; it is never evaluated. Numbers and booleans become text.
  const formula = zip({
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="C1" t="inlineStr"><is><t>notes</t></is></c></row>'
      + '<row r="2"><c r="A2" t="str"><f>HYPERLINK("https://example.invalid","x")</f><v>Synthetic Cached</v></c><c r="C2"><v>42</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(parseXlsx(formula), [['name', '', 'notes'], ['Synthetic Cached', '', '42', 'TRUE']]);
  assert.throws(() => parseXlsx(Buffer.from('plain text, not a zip archive at all')), (e: unknown) => e instanceof ImportFileError && e.reason === 'not_a_workbook');
  // An entry that inflates beyond the limit (a zip bomb) is refused.
  const bomb = zip({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${' '.repeat(9 * 1024 * 1024)}</sheetData></worksheet>` });
  assert.throws(() => parseXlsx(bomb), (e: unknown) => e instanceof ImportFileError);
  // An encrypted entry is refused.
  const encrypted = Buffer.from(zip({ 'xl/worksheets/sheet1.xml': '<worksheet/>' }));
  const cd = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(1, cd + 8);
  assert.throws(() => parseXlsx(encrypted), (e: unknown) => e instanceof ImportFileError && e.reason === 'encrypted_workbook');
  // A relationship target outside the package is ignored (sheet1.xml is used instead, and it is missing here).
  const escaping = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="../../etc/passwd"/></Relationships>',
  });
  assert.throws(() => parseXlsx(escaping), (e: unknown) => e instanceof ImportFileError && e.reason === 'not_a_workbook');
  assert.ok(deflateRawSync(Buffer.from('x')).length > 0);
});

test('supplier import: row mapping refuses before writing', () => {
  assert.deepEqual(mapImportRows([]).errors, [{ rowNumber: 1, column: 'name', code: 'import.header_missing' }]);
  assert.deepEqual(mapImportRows([['Name', 'Colour'], ['Synthetic A', 'red']]).errors, [{ rowNumber: 1, column: 'colour', code: 'import.unknown_column' }]);
  assert.deepEqual(mapImportRows([['notes'], ['x']]).errors, [{ rowNumber: 1, column: 'name', code: 'import.column_missing' }]);
  assert.deepEqual(mapImportRows([['name', 'name'], ['a', 'b']]).errors, [{ rowNumber: 1, column: 'name', code: 'import.duplicate_column' }]);
  const mapped = mapImportRows([
    ['name', 'identifier_kind', 'identifier_value', 'email', 'phone', 'categories', 'regions', 'status', 'payment_terms', 'notes'],
    ['  Synthetic   Alpha  ', 'us_ein', '00-0000004', 'buy@example.invalid', '+1 555 0101', 'a; b ;', 'us-ca', '', 'Net 15', 'note\u0007'],
    ['synthetic alpha', '', '', '', '', '', '', '', '', ''],
    ['Synthetic Beta', 'EIN', '1', '', '', '', '', 'approved', '', ''],
    ['Synthetic Gamma', '', '', 'not-an-email', '', '', '', '', '', ''],
    ['Synthetic Delta', '', '', '', '', '', 'Texas', 'approved', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
  ]);
  assert.equal(mapped.rows.length, 1);
  assert.deepEqual(mapped.rows[0], {
    rowNumber: 2, name: 'Synthetic   Alpha', identifiers: [{ kind: 'us_ein', value: '00-0000004' }],
    contacts: [{ role: 'imported', channel: 'email', value: 'buy@example.invalid' }, { role: 'imported', channel: 'phone', value: '+1 555 0101' }],
    categories: ['a', 'b'], regions: ['US-CA'], status: 'prospect', defaultPaymentTerms: 'Net 15', internalNotes: 'note',
  });
  assert.deepEqual(mapped.errors, [
    { rowNumber: 3, column: 'name', code: 'import.duplicate_name' },
    { rowNumber: 4, column: 'identifier_kind', code: 'import.invalid_value' },
    { rowNumber: 5, column: 'email', code: 'import.invalid_value' },
    { rowNumber: 6, column: 'regions', code: 'import.invalid_value' },
    { rowNumber: 7, column: 'name', code: 'import.invalid_value' },
  ]);
  assert.equal(nameKey('  Synthetic   Alpha '), 'synthetic alpha');
  assert.deepEqual([...IMPORT_COLUMNS], ['name', 'identifier_kind', 'identifier_value', 'email', 'phone', 'categories', 'regions', 'status', 'payment_terms', 'notes']);
});

test('supplier base parity: every declared capability id exists in the supply registry', () => {
  const ids = new Set(SUPPLY_CAPABILITIES.map((e) => e.capability.id));
  for (const op of SUPPLIER_BASE_CAPABILITY_OPERATIONS) {
    if (op.capabilityId !== null) assert.ok(ids.has(op.capabilityId), `${op.route}: ${op.capabilityId}`);
    else assert.ok(op.proposed && !ids.has(op.proposed), `${op.route}: a proposed id`);
  }
});
