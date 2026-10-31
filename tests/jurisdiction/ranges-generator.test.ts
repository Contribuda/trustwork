import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRangeTable, rangesFileGate, restrictedPlaces } from '../../packages/contracts/src/sanctions.js';
import { RESTRICTED } from '../../packages/country-packs/src/restricted.js';

const script = resolve(import.meta.dirname, '../../packages/compliance/bin/restricted-ranges.mjs');
const restricted = restrictedPlaces(RESTRICTED.places.map((p) => p.code));

// Synthetic rows in the DB-IP City Lite column order, on documentation address ranges only (RFC 5737, RFC 3849).
const CSV = [
  '192.0.2.0,192.0.2.127,EU,RU,"Moscow",Moscow,0,0',
  '192.0.2.128,192.0.2.255,EU,RU,"Saint Petersburg",Saint Petersburg,0,0',
  '198.51.100.0,198.51.100.63,EU,UA,"Autonomous Republic of Crimea",Simferopol,0,0',
  '198.51.100.64,198.51.100.95,EU,UA,"Sevastopol City",Sevastopol,0,0',
  '198.51.100.96,198.51.100.127,EU,UA,"Kyiv City",Kyiv,0,0',
  '198.51.100.128,198.51.100.191,EU,UA,"Donetsk Oblast",Donetsk,0,0',
  '198.51.100.192,198.51.100.255,EU,UA,"Luhansk",Luhansk,0,0',
  '203.0.113.0,203.0.113.255,NA,US,"California",San Diego,0,0',
  '2001:db8::,2001:db8:0:ffff:ffff:ffff:ffff:ffff,AS,IR,"Tehran",Tehran,0,0',
  '2001:db8:1::,2001:db8:1:ffff:ffff:ffff:ffff:ffff,EU,DE,"Berlin",Berlin,0,0',
].join('\n');

test('generator: reduces a city CSV to merged restricted ranges that the gate loads, offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-ranges-'));
  try {
    writeFileSync(join(dir, 'in.csv'), `${CSV}\n`);
    const out = join(dir, 'jurisdiction', 'restricted-ranges.json');
    const run = spawnSync(process.execPath, [script, '--input', join(dir, 'in.csv'), '--month', '2026-10', '--output', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const file = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(file.attribution, 'IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0');
    assert.deepEqual(file.codes, ['IR', 'RU', 'UA-09', 'UA-14', 'UA-40', 'UA-43']);
    assert.equal(file.v4.length, 5, 'the two Russian rows merge into one range; Kyiv and the US are dropped');
    const gate = rangesFileGate(loadRangeTable(file, restricted));
    const at = (a: string) => gate.decide({ address: a, header: () => null })?.place ?? null;
    assert.equal(at('192.0.2.200'), 'RU');
    assert.equal(at('198.51.100.10'), 'UA-43');
    assert.equal(at('198.51.100.70'), 'UA-40');
    assert.equal(at('198.51.100.100'), null, 'Kyiv is served');
    assert.equal(at('198.51.100.130'), 'UA-14');
    assert.equal(at('198.51.100.200'), 'UA-09');
    assert.equal(at('203.0.113.1'), null);
    assert.equal(at('2001:db8::42'), 'IR');
    assert.equal(at('2001:db8:1::42'), null);
    assert.equal(gate.describe().dataset, 'dbip-city-lite-2026-10');
    const usage = spawnSync(process.execPath, [script, '--input', join(dir, 'in.csv')], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
