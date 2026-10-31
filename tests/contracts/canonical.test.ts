import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalBytes, CanonicalizationError } from '../../packages/contracts/src/common/canonical.js';

// RFC 8785 section 3.2.3 example: numbers, string escaping and literals.
test('RFC 8785 appendix example reproduces the expected canonical bytes', () => {
  const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\u002f","literals":[null,true,false]}');
  const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(canonicalize(input), expected);
});
// RFC 8785 section 3.2.3 key sorting example: UTF-16 code-unit order (surrogate pair before U+FB33).
test('RFC 8785 key ordering uses UTF-16 code units, not code points', () => {
  const input = {
    '€': 'Euro Sign',
    '\r': 'Carriage Return',
    '\u000a': 'Newline',
    '1': 'One',
    '\u0080': 'Control\u007f',
    '😂': 'Smiley Face',
    ö: 'Latin Small Letter O With Diaeresis',
    דּ: 'Hebrew Letter Dalet With Dagesh',
  };
  const expected = '{"\\n":"Newline","\\r":"Carriage Return","1":"One","\u0080":"Control\u007f","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😂":"Smiley Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
  assert.equal(canonicalize(input), expected);
  assert.deepEqual([...canonicalBytes({ a: '€' })], [...new TextEncoder().encode('{"a":"€"}')]);
});
test('key order, whitespace and undefined members do not change the canonical form', () => {
  assert.equal(canonicalize({ b: 1, a: [1, 'x', { d: null, c: true }] }), canonicalize({ a: [1, 'x', { c: true, d: null }], b: 1 }));
  assert.equal(canonicalize({ a: 1, skipped: undefined }), '{"a":1}');
  assert.equal(canonicalize(JSON.parse(' { "z" : 10 , "y" : "10" } ')), '{"y":"10","z":10}');
  assert.notEqual(canonicalize({ q: '10' }), canonicalize({ q: '10.0' }));
  assert.notEqual(canonicalize({ q: 10 }), canonicalize({ q: '10' }));
});
test('non-finite numbers, bigint, dates, functions and undefined array items are rejected', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1n, new Date(0), () => 1, [undefined], { a: Symbol('s') }, new Map()]) {
    assert.throws(() => canonicalize(bad), CanonicalizationError, String(bad));
  }
});
test('NFC is not applied by JCS: composed and decomposed forms differ unless normalized earlier', () => {
  const composed = 'й';
  const decomposed = 'й';
  assert.notEqual(canonicalize({ s: composed }), canonicalize({ s: decomposed }));
  assert.equal(canonicalize({ s: composed }), canonicalize({ s: decomposed.normalize('NFC') }));
});
