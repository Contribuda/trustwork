import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AttestDeploymentLocationCommandSchema, DEPLOYMENT_ATTESTATION_RENEWAL_NOTICE_DAYS, DEPLOYMENT_ATTESTATION_VALIDITY_DAYS, deploymentAttestationStatus, DeploymentAttestationStatusSchema,
  DeploymentLocationAttestationSchema, DeploymentLocationAttestationSummarySchema, deploymentLocationRefusals, type DeploymentLocationAttestationSummary,
} from '../../packages/contracts/src/sanctions-attestation.js';
import { restrictedPlaces } from '../../packages/contracts/src/sanctions.js';

const DAY = 86_400_000;
// The authoritative list, read from the country-pack file as the web does (the API reads its kernel mirror).
const restricted = restrictedPlaces((JSON.parse(readFileSync(new URL('../../packages/country-packs/packs/restricted.json', import.meta.url), 'utf8')) as { places: { code: string }[] }).places.map((p) => p.code));
const attestedAt = new Date('2026-11-02T12:00:00.000Z');
const summary = (overrides: Partial<DeploymentLocationAttestationSummary> = {}): DeploymentLocationAttestationSummary => DeploymentLocationAttestationSummarySchema.parse({
  id: '0b8f0c4e-0000-4000-8000-000000000001', nodeId: '0b8f0c4e-0000-4000-8000-0000000000aa', operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null,
  gateMode: 'upstream_gate', statementDigest: 'a'.repeat(64), attestedAt: attestedAt.toISOString(), expiresAt: new Date(attestedAt.getTime() + 365 * DAY).toISOString(), supersedesId: null,
  basis: 'operator_statement', ...overrides,
});
const at = (days: number) => new Date(attestedAt.getTime() + days * DAY);
const status = (s: DeploymentLocationAttestationSummary | null, now: Date, configuration: Parameters<typeof deploymentAttestationStatus>[1]['configuration'] = { gateMode: 'upstream_gate' }, list = restricted) =>
  DeploymentAttestationStatusSchema.parse(deploymentAttestationStatus(s, { now, restricted: list, configuration }));

test('attestation contract: refusals of restricted places and missing regions mirror the database rule', () => {
  const ok = { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null };
  assert.deepEqual(deploymentLocationRefusals(ok, restricted), []);
  assert.deepEqual(deploymentLocationRefusals({ ...ok, hostingCountry: 'RU', hostingRegion: 'RU-MOW' }, restricted), [
    { field: 'hosting_country', place: 'RU', reason: 'restricted' }, { field: 'hosting_region', place: 'RU-MOW', reason: 'restricted' },
  ]);
  assert.deepEqual(deploymentLocationRefusals({ ...ok, operatorEntityCountry: 'IR', operatorEntityRegion: null }, restricted), [{ field: 'operator_entity_country', place: 'IR', reason: 'restricted' }]);
  assert.deepEqual(deploymentLocationRefusals({ ...ok, hostingCountry: 'UA', hostingRegion: 'UA-43' }, restricted), [{ field: 'hosting_region', place: 'UA-43', reason: 'restricted' }]);
  assert.deepEqual(deploymentLocationRefusals({ ...ok, hostingCountry: 'UA', hostingRegion: null }, restricted), [{ field: 'hosting_region', place: 'UA', reason: 'region_required' }]);
  assert.deepEqual(deploymentLocationRefusals({ ...ok, hostingCountry: 'UA', hostingRegion: 'UA-30' }, restricted), [], 'an unlisted Ukrainian region is not refused');
  assert.deepEqual(deploymentLocationRefusals({ ...ok, operatorEntityCountry: 'UA', operatorEntityRegion: null }, restricted), [{ field: 'operator_entity_region', place: 'UA', reason: 'region_required' }]);
});

test('attestation contract: the command needs a confirmed statement of the current version, a real gate mode and regions of the stated country', () => {
  const base = { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate', supersedes: null, statementVersion: 'deployment-location-1', confirmed: true, reason: 'Initial setup' };
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse(base).success, true);
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, confirmed: false }).success, false, 'no implicit attestation');
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, gateMode: 'fake' }).success, false, 'fake is not a deployment statement');
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, hostingRegion: 'DE-HE' }).success, false, 'a region of another country');
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, statementVersion: 'deployment-location-0' }).success, false);
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, reason: ' ' }).success, false);
  assert.equal(AttestDeploymentLocationCommandSchema.safeParse({ ...base, detectedCountry: 'US' }).success, false, 'nothing detected about the server is accepted');
  assert.equal(DeploymentLocationAttestationSummarySchema.safeParse({ ...summary(), expiresAt: at(400).toISOString() }).success, false, 'never valid for more than a year');
  assert.equal(DeploymentLocationAttestationSchema.safeParse({ ...summary(), statementVersion: 'deployment-location-1', attestedBy: 'p1', attesterRole: 'node-operator', permission: 'admin.hub.read', sessionElevationId: 'e1', breakglass: false }).success, false, 'only attesting permissions');
});

test('attestation status (clock): missing opens the gate; valid, then renewal due, then expired at a year reopens it', () => {
  const missing = status(null, at(0));
  assert.equal(missing.state, 'missing');
  assert.deepEqual(missing.launchGate, { gate: 'sanctions_screening_configured', contribution: 'open' });
  assert.deepEqual(missing.reminder, { kind: 'attest', dueAt: null });
  assert.equal(missing.basis, 'operator_statement');

  const s = summary();
  const fresh = status(s, at(1));
  assert.equal(fresh.state, 'valid');
  assert.deepEqual(fresh.problems, []);
  assert.equal(fresh.launchGate.contribution, 'satisfied');
  assert.equal(fresh.reminder, null);
  assert.equal(fresh.renewalDueAt, at(DEPLOYMENT_ATTESTATION_VALIDITY_DAYS - DEPLOYMENT_ATTESTATION_RENEWAL_NOTICE_DAYS).toISOString());

  const due = status(s, at(DEPLOYMENT_ATTESTATION_VALIDITY_DAYS - DEPLOYMENT_ATTESTATION_RENEWAL_NOTICE_DAYS));
  assert.equal(due.state, 'renewal_due');
  assert.equal(due.launchGate.contribution, 'satisfied', 'still in force while renewal is due');
  assert.deepEqual(due.reminder, { kind: 'renew', dueAt: s.expiresAt });

  const lastMoment = status(s, new Date(Date.parse(s.expiresAt) - 1));
  assert.equal(lastMoment.state, 'renewal_due');
  const expired = status(s, new Date(Date.parse(s.expiresAt)));
  assert.equal(expired.state, 'expired');
  assert.deepEqual(expired.problems, ['expired']);
  assert.deepEqual(expired.launchGate, { gate: 'sanctions_screening_configured', contribution: 'invalidated' });
  assert.deepEqual(expired.reminder, { kind: 'reattest', dueAt: null });
  assert.equal(status(s, at(366)).state, 'expired', 'older than a year');
  assert.equal(status(s, new Date(Number.NaN)).state, 'expired', 'an invalid clock never keeps it in force');
});

test('attestation status: a configuration change contradicts the attestation and reopens the gate', () => {
  const s = summary();
  const modeChanged = status(s, at(10), { gateMode: 'edge_header' });
  assert.equal(modeChanged.state, 'contradicted');
  assert.deepEqual(modeChanged.problems, ['gate_mode_changed']);
  assert.equal(modeChanged.launchGate.contribution, 'invalidated');
  assert.deepEqual(modeChanged.reminder, { kind: 'reattest', dueAt: null });
  assert.deepEqual(status(s, at(10), { gateMode: 'unconfigured' }).problems, ['gate_mode_changed'], 'an unconfigured gate contradicts any attested mode');
  const moved = status(s, at(10), { gateMode: 'upstream_gate', hostingCountry: 'DE', hostingRegion: 'DE-HE', operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE' });
  assert.equal(moved.state, 'contradicted');
  assert.deepEqual(moved.problems, ['hosting_country_changed', 'hosting_region_changed']);
  const entity = status(s, at(10), { gateMode: 'upstream_gate', operatorEntityCountry: 'GB' });
  assert.deepEqual(entity.problems, ['operator_entity_country_changed']);
  assert.equal(status(s, at(10), { gateMode: 'upstream_gate', hostingCountry: 'US' }).state, 'valid', 'a configuration that agrees changes nothing');
  const both = status(s, at(400), { gateMode: 'ranges_file' });
  assert.equal(both.state, 'contradicted');
  assert.deepEqual(both.problems, ['gate_mode_changed', 'expired']);
});

test('attestation status: a stated place that the list now restricts (or now needs a region for) takes it out of force', () => {
  const s = summary({ hostingCountry: 'GE', hostingRegion: null, operatorEntityCountry: 'GE', operatorEntityRegion: null });
  assert.equal(status(s, at(10)).state, 'valid');
  const grown = restrictedPlaces([...restricted.codes, 'GE-AB']);
  const regionNow = status(s, at(10), { gateMode: 'upstream_gate' }, grown);
  assert.equal(regionNow.state, 'contradicted');
  assert.deepEqual(regionNow.problems, ['region_now_required']);
  const restrictedNow = status(s, at(10), { gateMode: 'upstream_gate' }, restrictedPlaces([...restricted.codes, 'GE']));
  assert.equal(restrictedNow.state, 'restricted');
  assert.deepEqual(restrictedNow.problems, ['place_now_restricted']);
  assert.equal(restrictedNow.launchGate.contribution, 'invalidated');
});
