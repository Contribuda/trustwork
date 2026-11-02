/**
 * REG-001 probe of the company-page register panel, run by panel.test.ts in a child process with this directory's
 * tsconfig (the web app's `@/` paths). It renders the server component to markup in Georgian and English and checks
 * what a visitor reads: kind and status labels from the dictionaries, dates through Intl, the stale note, the
 * register link (new tab, no referrer, nofollow), the "how this is sourced" explanation, and nothing at all when
 * there is no fact. Every fact is synthetic and links to the reserved `.invalid` domain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { localeLayers, messageIn } from '@/app/_lib/locale';
import { RegisterFacts, factDetail, factStatus } from '@/components/public/RegisterFacts';
import type { RegisterFactView } from '@/app/_lib/data/types';

// tsx compiles the web app's TSX with the classic runtime (the app's tsconfig preserves JSX for Next), so React is global here.
Object.assign(globalThis, { React });

const facts: RegisterFactView[] = [
  { kind: 'licence_status', identifierKind: 'US-CA-CSLB', value: { status: 'active', classifications: ['B', 'C-10'], issuedOn: null },
    link: 'https://synthetic-register.invalid/us_ca_cslb_licence_file/1000123', observedAt: '2026-11-01T10:00:00.000Z', validUntil: '2027-03-31', stale: false },
  { kind: 'lei_record', identifierKind: 'XX-LEI', value: { registrationStatus: 'lapsed', entityStatus: 'active' },
    link: 'https://synthetic-register.invalid/gleif_lei/5299SYNTHETIC0000042', observedAt: '2026-10-01T10:00:00.000Z', validUntil: '2026-10-15', stale: true },
  { kind: 'safety_inspection', identifierKind: null, value: { inspectionRef: 'SYN-1', openedOn: '2026-03-04', inspectionType: 'planned', status: 'closed', citations: 2 },
    link: 'https://synthetic-register.invalid/us_osha_inspections/SYN-1', observedAt: '2026-11-01T10:00:00.000Z', validUntil: null, stale: false },
];
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('the panel renders the register words in Georgian with Intl dates, the stale note and safe links', () => {
  setLocaleStore({ locale: 'ka', country: 'GE', layers: localeLayers('ka') });
  const html = decode(renderToStaticMarkup(<RegisterFacts facts={facts} />));
  for (const key of ['title', 'how', 'stale', 'open', 'kind.licence_status', 'kind.lei_record', 'kind.safety_inspection', 'status.active', 'status.lapsed', 'status.closed']) {
    assert.ok(html.includes(messageIn('ka', `companyPage.registerFacts.${key}`)), key);
  }
  assert.ok(html.includes('B, C-10'));
  assert.equal((html.match(/rel="noopener noreferrer nofollow"/g) ?? []).length, 3);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 3);
  assert.equal((html.match(/data-stale="true"/g) ?? []).length, 1);
  assert.ok(!/verified|certif|licensed by/i.test(html));
});

test('the English panel names statuses and details from the register fields only', () => {
  setLocaleStore({ locale: 'en', country: 'US', layers: localeLayers('en') });
  assert.equal(factStatus(facts[0]!), 'active');
  assert.equal(factStatus(facts[1]!), 'lapsed');
  assert.equal(factStatus({ value: { status: 'certified' } }), null, 'an unknown status is never shown');
  assert.equal(factDetail(facts[0]!), 'Classes: B, C-10');
  assert.match(factDetail(facts[2]!) ?? '', /Citations: 2$/);
  assert.equal(factDetail({ kind: 'entity_status', value: { status: 'active', entityType: 'llc' } }), null);
  const html = decode(renderToStaticMarkup(<RegisterFacts facts={facts} />));
  assert.ok(html.includes('From public registers'));
  assert.ok(html.includes('How this is sourced'));
});

test('no fact, no panel', () => {
  assert.equal(renderToStaticMarkup(<RegisterFacts facts={[]} />), '');
});
