import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OUTREACH_CHANNELS, OUTREACH_ENGINE_FLOOR, RECIPIENT_CLASSES, suppressSmallCount } from '@trustwork/contracts/client';
import { permissionsFor, rolesFor } from '../../../../apps/web/app/admin/_data/access.js';
import { SECTIONS } from '../../../../apps/web/app/admin/_data/sections.js';
import { FIXTURE_NOW, HUB_SAMARKAND_ID, HUB_US_ID, NODE_ID } from '../../../../apps/web/app/admin/_fixtures/ids.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { STAFF, STAFF_PERSONAS } from '../../../../apps/web/app/admin/_fixtures/staff.js';
import type { SectionCommandContext, SectionCommandInput } from '../../../../apps/web/app/admin/hubs/[hub]/participants/_section-command.js';
import { evaluateOutreach, OUTREACH_COMMANDS, OUTREACH_KINDS, OUTREACH_REJECT_CODES, type OutreachOutcome } from '../../../../apps/web/app/admin/hubs/[hub]/outreach/_commands.js';
import { outreachOf } from '../../../../apps/web/app/admin/hubs/[hub]/outreach/_kit/fixtures.js';
import { exactSuppression, normaliseIdentifier } from '../../../../apps/web/app/admin/hubs/[hub]/outreach/_kit/lookup.js';
import { activePolicy, CAMPAIGN_CHANNELS, CAMPAIGN_CLASSES, CampaignSchema, LOCKED_BLOCKS, OutreachViewSchema } from '../../../../apps/web/app/admin/hubs/[hub]/outreach/_kit/schemas.js';

/**
 * OUTR-004: the outreach section (HC-170 to HC-177) on fixtures. The acceptance criteria are checked here against the
 * pure command evaluation, the fixtures and the source tree (scans), and in the browser by outreach-console.spec.ts:
 * no control enables consumer outreach or an automated, consent-only or forbidden channel; suppression is reachable
 * only by exact lookup; every campaign shows the exact message per language and jurisdiction; small cohorts suppressed.
 */

const now = new Date(FIXTURE_NOW);
const us = HUBS.find((h) => h.hub.id === HUB_US_ID)!;
const samarkand = HUBS.find((h) => h.hub.id === HUB_SAMARKAND_ID)!;
const usView = outreachOf(HUB_US_ID)!;
type Persona = keyof typeof STAFF_PERSONAS;

function ctx(persona: Persona, overrides: Partial<SectionCommandContext> = {}, hub = us): SectionCommandContext {
  const person = STAFF.people.find((p) => p.id === STAFF_PERSONAS[persona])!;
  const target = { nodeId: NODE_ID, hubId: hub.hub.id };
  return {
    viewer: { person, elevation: { state: 'elevated', until: '2026-10-31T12:10:00Z' } },
    access: { roles: rolesFor(STAFF, person.id, target, now), permissions: [...permissionsFor(STAFF, person.id, target, now)] },
    hub,
    now,
    offline: false,
    ...overrides,
  };
}
const input = (command: string, fields: Record<string, string> = {}, reason = 'Synthetic test reason'): SectionCommandInput => ({ command, reason, expectedRevision: us.hub.revision, fields });
const code = (o: OutreachOutcome) => (o.status === 'rejected' ? o.code : o.status);
const kind = (o: OutreachOutcome) => (o.status === 'demo_not_saved' ? o.kind : code(o));

/* ---------- Fixtures ---------- */

test('fixtures are synthetic, parse with the outreach contracts and keep both hubs under the strict rule', () => {
  for (const id of [HUB_US_ID, HUB_SAMARKAND_ID]) {
    const view = outreachOf(id)!;
    assert.ok(OutreachViewSchema.safeParse(view).success, id);
    assert.equal(activePolicy(view).mode, 'strict', `${id}: nobody is contacted`);
    assert.ok(view.campaigns.every((c) => c.state !== 'running'));
    assert.match(view.sender.domain, /\.(example|invalid)$/);
    for (const e of view.suppressionLedger) assert.match(e.identifier, /\.(invalid|example)$/);
    for (const c of view.campaigns) for (const p of c.previews) for (const b of p.blocks) for (const url of b.text.match(/https?:\/\/[^\s,]+/g) ?? []) assert.match(url, /^https:\/\/[a-z.-]+\.example\//, url);
  }
  assert.ok(usView.rehearsal, 'replies come from a labelled staff rehearsal');
  assert.equal(outreachOf('hub-nowhere'), null);
});

test('the contracts refuse a campaign for consumers or on an automated, consent-only or forbidden channel', () => {
  const sample = usView.campaigns[0]!;
  for (const recipientClass of OUTREACH_ENGINE_FLOOR.prohibitedClasses) assert.equal(CampaignSchema.safeParse({ ...sample, recipientClass }).success, false, recipientClass);
  for (const channel of [...OUTREACH_ENGINE_FLOOR.prohibitedChannels, ...OUTREACH_ENGINE_FLOOR.consentOnlyChannels]) assert.equal(CampaignSchema.safeParse({ ...sample, channel }).success, false, channel);
  assert.deepEqual([...CAMPAIGN_CLASSES].sort(), RECIPIENT_CLASSES.filter((c) => c !== 'consumer').sort());
  assert.deepEqual([...CAMPAIGN_CHANNELS].sort(), ['email', 'phone_manual', 'postal']);
  const running = { ...usView, campaigns: [{ ...sample, state: 'running' }] };
  assert.equal(OutreachViewSchema.safeParse(running).success, false, 'nothing runs under the strict rule');
});

test('acceptance 3: every campaign shows the exact message for each language and its jurisdiction, locked blocks included', () => {
  for (const c of usView.campaigns) {
    assert.ok(c.previews.length >= 1, c.id);
    for (const p of c.previews) {
      assert.equal(p.jurisdiction, c.jurisdiction, `${c.id}: preview for the campaign jurisdiction`);
      for (const block of LOCKED_BLOCKS) assert.ok(p.blocks.some((b) => b.kind === block && b.locked), `${c.id} ${p.lang}: ${block}`);
      assert.deepEqual(p.blocks.filter((b) => !b.locked).map((b) => b.kind), ['body'], 'only the body is editable');
    }
  }
  const invite = usView.campaigns.find((c) => c.id === 'claim-invite-roofing')!;
  assert.deepEqual(invite.previews.map((p) => p.lang).sort(), ['en', 'es'], 'the US hub languages');
  const broken = { ...invite, previews: [{ ...invite.previews[0]!, blocks: invite.previews[0]!.blocks.filter((b) => b.kind !== 'unsubscribe') }] };
  assert.equal(CampaignSchema.safeParse(broken).success, false, 'a message without the unsubscribe block does not parse');
});

test('acceptance 4: cohort counts under ten are suppressed in the fixtures and refused by the schema', () => {
  assert.equal(suppressSmallCount(6), null);
  assert.equal(usView.campaigns.find((c) => c.id === 'correction-framing')!.audience, null, 'an audience of six is suppressed');
  assert.equal(usView.journeys.find((j) => j.id === 'partner-onboarding')!.enrolled, null);
  assert.equal(usView.rates.sent, null);
  assert.ok(usView.suppressionCounts.some((s) => s.count === null));
  assert.equal(OutreachViewSchema.safeParse({ ...usView, doNotCollect: 4 }).success, false, 'a raw count under ten does not parse');
});

test('the built sections are exactly HC-170 to HC-177 with status demo', () => {
  const own = SECTIONS.filter((s) => s.group.id === 'outreach');
  assert.deepEqual(own.map((s) => s.section.screen), ['HC-170', 'HC-171', 'HC-172', 'HC-173', 'HC-174', 'HC-175', 'HC-176', 'HC-177']);
  for (const { section } of own) assert.equal(section.status, 'demo');
  assert.deepEqual(own.find((s) => s.section.id === 'suppression')!.section.read, ['admin.privacy.request.read'], 'only privacy staff open the suppression screen');
  assert.ok((own.find((s) => s.section.id === 'policies')!.section.read as readonly string[]).includes('admin.hub.jurisdiction.activate'), 'the person who requests activation can read what they activate');
});

/* ---------- Negative authorization ---------- */

test('negative authorization: no role, wrong role, other hub, no elevation, offline, no reason, anonymous, unknown command', () => {
  const cases: Array<[string, Record<string, string>, Persona, Persona]> = [
    ['outreach.campaign_draft', { purpose: 'claim_invitation', recipientClass: 'business_role', channel: 'email' }, 'editor', 'privacy'],
    ['outreach.policy_draft', { mode: 'notice_only' }, 'hub-owner', 'editor'],
    ['outreach.suppression_add', { identifier: 'info@example-new.invalid', reason: 'objection', scope: 'hub' }, 'privacy', 'editor'],
    ['outreach.kill_switch_engage', {}, 'ops', 'privacy'],
  ];
  for (const [command, fields, allowed, wrong] of cases) {
    assert.equal(code(evaluateOutreach(input(command, fields), ctx('staff-none'))), 'denied', `${command}: staff-none`);
    assert.equal(code(evaluateOutreach(input(command, fields), ctx(wrong))), 'denied', `${command}: ${wrong}`);
    // Hub owner and privacy roles are US-only (the editor also edits in Samarkand, operations is node-wide).
    if (allowed === 'hub-owner' || allowed === 'privacy') assert.equal(code(evaluateOutreach(input(command, fields), ctx(allowed, {}, samarkand))), 'denied', `${command}: a US role does not act on Samarkand`);
    const notElevated = ctx(allowed);
    notElevated.viewer = { ...notElevated.viewer!, elevation: { state: 'required' } };
    assert.equal(code(evaluateOutreach(input(command, fields), notElevated)), 'elevation_required', `${command}: elevation`);
    assert.equal(code(evaluateOutreach(input(command, fields), ctx(allowed, { offline: true }))), 'offline', `${command}: offline`);
    assert.equal(code(evaluateOutreach(input(command, fields, '  '), ctx(allowed))), 'reason_required', `${command}: reason`);
    assert.equal(code(evaluateOutreach(input(command, fields), ctx(allowed, { viewer: null }))), 'not_found', `${command}: anonymous`);
    assert.equal(evaluateOutreach(input(command, fields), ctx(allowed)).status, 'demo_not_saved', `${command}: ${allowed}`);
  }
  for (const unknown of ['outreach.set_mode', 'outreach.lower_floor', 'outreach.suppression_list', 'outreach.reply_execute', 'outreach.kill_switch_release']) {
    assert.equal(code(evaluateOutreach(input(unknown), ctx('editor'))), 'invalid', `${unknown} does not exist`);
  }
});

/* ---------- Command rules ---------- */

test('mode changes: a draft never activates; a non-strict version needs a counsel record, then a second person', () => {
  assert.equal(kind(evaluateOutreach(input('outreach.policy_draft', { mode: 'governed' }), ctx('hub-owner'))), 'version');
  assert.equal(code(evaluateOutreach(input('outreach.policy_request_activation', { version: 'outreach-policy-v2' }), ctx('compliance'))), 'counsel_required', 'v2 is notice-only without a counsel record');
  assert.equal(code(evaluateOutreach(input('outreach.policy_request_activation', { version: 'outreach-policy-v1' }), ctx('compliance'))), 'not_found', 'the active version is not a draft');
  const withCounsel = structuredClone(usView);
  withCounsel.policyVersions.find((p) => p.id === 'outreach-policy-v2')!.counselApproval = { reference: 'CR-1 (demo)', jurisdictions: ['US-CA'], approvedAt: '2026-10-30T10:00:00Z' };
  assert.ok(OutreachViewSchema.safeParse(withCounsel).success);
});

test('campaigns: drafts accept only allowed classes and channels; activation is refused under the strict rule; resume only when paused', () => {
  const editor = ctx('editor');
  const draft = { purpose: 'claim_invitation', recipientClass: 'business_role', channel: 'email' };
  assert.equal(kind(evaluateOutreach(input('outreach.campaign_draft', draft), editor)), 'version');
  for (const recipientClass of OUTREACH_ENGINE_FLOOR.prohibitedClasses) assert.equal(code(evaluateOutreach(input('outreach.campaign_draft', { ...draft, recipientClass }), editor)), 'invalid', recipientClass);
  for (const channel of OUTREACH_CHANNELS.filter((c) => !CAMPAIGN_CHANNELS.includes(c))) assert.equal(code(evaluateOutreach(input('outreach.campaign_draft', { ...draft, channel }), editor)), 'invalid', channel);
  assert.equal(code(evaluateOutreach(input('outreach.campaign_draft', { ...draft, purpose: 'cold_sales' }), editor)), 'invalid');
  assert.equal(kind(evaluateOutreach(input('outreach.campaign_dry_run', { campaign: 'claim-invite-roofing' }), editor)), 'dry_run');
  assert.equal(code(evaluateOutreach(input('outreach.campaign_request_activation', { campaign: 'claim-invite-roofing' }), editor)), 'strict_mode');
  assert.equal(code(evaluateOutreach(input('outreach.campaign_request_activation', { campaign: 'nope' }), editor)), 'not_found');
  assert.equal(code(evaluateOutreach(input('outreach.campaign_resume', { campaign: 'claim-invite-roofing' }), editor)), 'not_paused');
  assert.equal(kind(evaluateOutreach(input('outreach.campaign_pause', { campaign: 'claim-invite-roofing' }), ctx('ops'))), 'paused', 'operations staff can pause');
  assert.equal(kind(evaluateOutreach(input('outreach.campaign_stop', { campaign: 'claim-invite-roofing' }), ctx('ops'))), 'stopped');
  assert.equal(code(evaluateOutreach(input('outreach.campaign_resume', { campaign: 'claim-invite-roofing' }), ctx('ops'))), 'denied', 'pausing does not grant resuming');
});

test('templates, replies, journeys and the kill switch', () => {
  const editor = ctx('editor');
  assert.equal(code(evaluateOutreach(input('outreach.template_request_activation', { template: 'correction_request' }), editor)), 'locale_missing', 'Spanish is missing');
  assert.equal(kind(evaluateOutreach(input('outreach.template_request_activation', { template: 'claim_invitation' }), editor)), 'second_person');
  assert.equal(kind(evaluateOutreach(input('outreach.template_edit', { template: 'claim_invitation', body: 'New body' }), editor)), 'version');
  assert.equal(code(evaluateOutreach(input('outreach.reply_reclassify', { reply: 'reply-rehearsal-2', class: 'execute' }), editor)), 'invalid');
  assert.equal(kind(evaluateOutreach(input('outreach.reply_reclassify', { reply: 'reply-rehearsal-2', class: 'objection' }), editor)), 'saved');
  assert.equal(kind(evaluateOutreach(input('outreach.reply_wrong_recipient', { reply: 'reply-rehearsal-5' }), editor)), 'suppressed');
  assert.equal(code(evaluateOutreach(input('outreach.reply_wrong_recipient', { reply: 'reply-x' }), editor)), 'not_found');
  assert.equal(kind(evaluateOutreach(input('outreach.journey_activate', { journey: 'partner-onboarding' }), editor)), 'second_person');
  assert.equal(kind(evaluateOutreach(input('outreach.journey_pause', { journey: 'welcome-companies' }), editor)), 'paused');
  assert.equal(kind(evaluateOutreach(input('outreach.kill_switch_engage'), ctx('ops'))), 'engaged');
  const engaged = { ...usView, killSwitch: 'engaged' as const };
  assert.ok(OutreachViewSchema.safeParse(engaged).success);
  assert.equal(code(evaluateOutreach(input('outreach.suppression_add', { identifier: 'ab', reason: 'objection', scope: 'hub' }), ctx('privacy'))), 'invalid');
  assert.equal(code(evaluateOutreach(input('outreach.suppression_add', { identifier: 'info@example-new.invalid', reason: 'whim', scope: 'hub' }), ctx('privacy'))), 'invalid');
});

/* ---------- Acceptance 2: suppression only by exact lookup ---------- */

test('acceptance 2: the suppression lookup matches one exact identifier, never a part, a wildcard or a listing', () => {
  const ledger = usView.suppressionLedger;
  assert.equal(exactSuppression(ledger, '  Contact@Example-Plumbing.invalid ')?.reason, 'objection', 'case and spaces are ignored');
  for (const partial of ['contact@', 'example-plumbing.invalid', 'contact@example-plumbing', '*', '%', '.*', '', 'in', 'contact@example-plumbing.invalid,info@example-tile.invalid']) {
    assert.equal(exactSuppression(ledger, partial), null, `"${partial}" finds nothing`);
  }
  assert.equal(exactSuppression(ledger, 'x'.repeat(321)), null);
  assert.equal(normaliseIdentifier(' A@B.invalid '), 'a@b.invalid');
  assert.equal(exactSuppression(outreachOf(HUB_SAMARKAND_ID)!.suppressionLedger, 'contact@example-plumbing.invalid'), null, 'another hub finds nothing');
});

const OUTREACH = resolve('apps/web/app/admin/hubs/[hub]/outreach');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const SCREENS = files(OUTREACH).filter((f) => f.endsWith('.tsx'));
const source = (f: string) => readFileSync(f, 'utf8');

test('acceptance 2 (scan): the ledger is read only through the exact lookup and never rendered', () => {
  const uses = files(OUTREACH)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('fixtures.ts') && !f.endsWith('schemas.ts'))
    .flatMap((f) => [...source(f).matchAll(/suppressionLedger[^\n]*/g)].map((m) => `${f.slice(OUTREACH.length)}: ${m[0]}`));
  assert.deepEqual(uses, ['/_kit/parts.tsx: suppressionLedger, asked) : null;'], 'one use: the argument of exactSuppression');
  for (const f of SCREENS) assert.doesNotMatch(source(f), /suppressionLedger\.(map|filter|slice|forEach|length)|startsWith\(|includes\(asked|LIKE|ILIKE/, f);
  const suppression = source(join(OUTREACH, 'suppression/_screen.tsx'));
  assert.doesNotMatch(suppression, /suppressionLedger/, 'the screen itself never touches the ledger');
});

/* ---------- Acceptance 1: no control enables forbidden outreach ---------- */

/** The POST forms of the outreach screens: each `<OutreachForm ...>...</OutreachForm>` (or self-closing) block. */
function postForms(text: string): string[] {
  const out: string[] = [];
  const re = /<OutreachForm\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index);
    const close = rest.indexOf('</OutreachForm>');
    const selfClose = rest.indexOf('/>');
    const opening = rest.indexOf('>');
    const isSelf = selfClose !== -1 && selfClose < opening + 1 && (close === -1 || selfClose < close);
    out.push(isSelf ? rest.slice(0, selfClose + 2) : rest.slice(0, close + '</OutreachForm>'.length));
  }
  return out;
}
const FORBIDDEN = [...OUTREACH_ENGINE_FLOOR.prohibitedClasses, ...OUTREACH_ENGINE_FLOOR.prohibitedChannels, ...OUTREACH_ENGINE_FLOOR.consentOnlyChannels];

test('the scan sees every POST form and would catch an offending option', () => {
  const forms = SCREENS.flatMap((f) => postForms(source(f)));
  const commands = new Set(forms.flatMap((f) => [...f.matchAll(/command="([^"]+)"/g)].map((m) => m[1])));
  assert.deepEqual([...commands].filter((c) => !OUTREACH_COMMANDS[c!]), [], 'every form names a known command');
  assert.ok(commands.size >= 15, `forms found: ${commands.size}`);
  const bad = '<OutreachForm ctx={ctx} command="outreach.campaign_draft"><SelectField name="channel" options={OUTREACH_CHANNELS.map((c) => c)} /></OutreachForm>';
  assert.match(postForms(bad)[0]!, /OUTREACH_CHANNELS/);
});

test('acceptance 1 (scan): no POST form offers consumers, automated calls or AI voice, SMS or messengers, contact forms or social messages', () => {
  const offending: string[] = [];
  for (const f of SCREENS) {
    for (const form of postForms(source(f))) {
      if (/\b(RECIPIENT_CLASSES|OUTREACH_CHANNELS)\b/.test(form)) offending.push(`${f.slice(OUTREACH.length)}: offers the unfiltered class or channel list`);
      for (const value of FORBIDDEN) if (form.includes(`'${value}'`) || form.includes(`"${value}"`)) offending.push(`${f.slice(OUTREACH.length)}: ${value}`);
      if (/\bname="(consent|f\.consent|automated|voice|floor\w*)"/.test(form)) offending.push(`${f.slice(OUTREACH.length)}: a consent or floor switch`);
    }
  }
  assert.deepEqual(offending, []);
  // The campaign draft offers exactly the allowed lists; the simulator (a GET form that stores and sends nothing) may show every value.
  const campaigns = source(join(OUTREACH, 'campaigns/_screen.tsx'));
  assert.match(campaigns, /options=\{CAMPAIGN_CLASSES\.map/);
  assert.match(campaigns, /options=\{CAMPAIGN_CHANNELS\.map/);
  const policies = source(join(OUTREACH, 'policies/_screen.tsx'));
  const simulator = policies.slice(policies.indexOf('<GetForm'), policies.indexOf('</GetForm>'));
  assert.match(simulator, /OUTREACH_CHANNELS/, 'the simulator shows every channel so staff see the refusal');
  // The engine floor is rendered as rows, never as switches.
  const parts = source(join(OUTREACH, '_kit/parts.tsx'));
  const floor = parts.slice(parts.indexOf('export function EngineFloor'), parts.indexOf('export function', parts.indexOf('export function EngineFloor') + 10));
  assert.ok(floor.length > 100, 'EngineFloor found');
  assert.doesNotMatch(floor, /<input|Switch|Checkbox|OutreachForm|SelectField/);
});

test('acceptance 1: every command that could carry a class or channel refuses the forbidden values', () => {
  for (const value of FORBIDDEN) {
    for (const field of ['recipientClass', 'channel']) {
      const fields = { purpose: 'claim_invitation', recipientClass: 'business_role', channel: 'email', [field]: value };
      assert.equal(code(evaluateOutreach(input('outreach.campaign_draft', fields), ctx('editor'))), 'invalid', `${field}=${value}`);
    }
  }
});

/* ---------- Messages and locales ---------- */

const LOCALES = resolve('apps/web/locales');
function flat(tag: string, file: string): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(node: unknown, path: string) {
    if (typeof node === 'string') out.set(path, node);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  })(JSON.parse(readFileSync(join(LOCALES, tag, file), 'utf8')), '');
  return out;
}

test('every reject code and outcome kind has an English message', () => {
  const en = flat('en', 'admin-outreach.json');
  assert.deepEqual(OUTREACH_REJECT_CODES.filter((c) => !en.has(`adminOutreach.errors.${c}`)), []);
  assert.deepEqual(OUTREACH_KINDS.filter((k) => !en.has(`adminOutreach.outcomes.${k}`)), []);
});

/** Maintained languages; Russian is not maintained (ADR 009 decision 11) and falls back to English. */
const ENGINE_LANGUAGES = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const LATIN = /\b(SPF|DKIM|DMARC|DNS|SMS|ISO|US-CA|AI|LLC|soft opt-in|stop|plural|one|few|many|other)\b/g;

test('every maintained language has the namespace with exactly the English keys, placeholders and plural forms', () => {
  const en = flat('en', 'admin-outreach.json');
  for (const tag of ENGINE_LANGUAGES) {
    const dict = flat(tag, 'admin-outreach.json');
    assert.deepEqual([...en.keys()].filter((k) => !dict.has(k)), [], `${tag}: missing keys`);
    assert.deepEqual([...dict.keys()].filter((k) => !en.has(k)), [], `${tag}: extra keys`);
    for (const [key, value] of dict) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
      assert.deepEqual(names(value), names(en.get(key)!), `${tag}: ${key} placeholders`);
      assert.ok(value.trim(), `${tag}: ${key} empty`);
      if (/, plural,/.test(en.get(key)!)) assert.match(value, /other \{/, `${tag}: ${key} plural needs other`);
    }
  }
});

test('no Russian outreach namespace is added, and Latin-script languages carry no Cyrillic', () => {
  assert.throws(() => readFileSync(join(LOCALES, 'ru', 'admin-outreach.json')), 'Russian is not maintained');
  for (const tag of ['es', 'uz-Latn', 'az-Latn']) assert.deepEqual([...flat(tag, 'admin-outreach.json')].filter(([, v]) => /[Ѐ-ӿ]/.test(v)).map(([k]) => k), [], tag);
  for (const tag of ['ka', 'hy']) {
    const latin = [...flat(tag, 'admin-outreach.json')].filter(([, v]) => /[A-Za-z]{4,}/.test(v.replace(/\{[^}]*\}/g, '').replace(LATIN, '')));
    assert.deepEqual(latin.map(([k, v]) => `${k}: ${v}`), [], `${tag}: Latin words`);
  }
});
