import type { Readable } from 'node:stream';
import { FilesService } from './modules/files/files.service.js';
import { NoFileMandates } from './modules/files/mandates.js';
import { withOwnPrivacyFile } from './modules/files/privacy-export.js';
import type { FilesModuleOptions } from './modules/files/config.js';
import { sql } from 'kysely';
import { composeModuleExports, type PrivacyOwningPorts } from './privacy-module-exporters.js';
import { PRIVACY_MODULE_INVENTORY } from '../../../packages/contracts/src/privacy.js';
import type { Principal } from './deps/contracts.js';
import type { Transaction } from './deps/data.js';
import type { RequestState } from './common/request.js';
import type { AppContext } from './modules/identity/context.js';
import { PrincipalService } from './modules/identity/principal.service.js';
import type { IdentityServices } from './modules/identity/identity.module.js';
import { MembershipService } from './modules/identity/membership.service.js';
import { ProfilesService } from './modules/profiles/profiles.service.js';
import { NoProfileMandates } from './modules/profiles/mandates.js';
import { ProjectsService } from './modules/projects/projects.service.js';
import { CatalogueService } from './modules/catalogue/catalogue.service.js';
import { ProcurementService } from './modules/procurement/procurement.service.js';
import { NoCommerceMandates } from './modules/procurement/mandates.js';
import { SalesService } from './modules/sales/sales.service.js';
import { NoDealMandates } from './modules/sales/mandates.js';
import { SellerStatedTax } from './modules/sales/tax.js';
import { TransactionsService } from './modules/transactions/transactions.service.js';
import { ConfiguredElectronicRecords } from './modules/transactions/electronic-records.js';
import type { PrivacySubject } from '../../../packages/contracts/src/privacy.js';

/** Explicit coverage, never a declaration that a subset is a full subject export. */
const MODULE_COVERAGE = [
  { module: 'approval-routes', status: 'partial', includes: 'all own-company route versions and request decision cards, current delegations; person-only decision history pending' },
  { module: 'supplier-base', status: 'partial', includes: 'all own-company supplier records, assessments and external counterparties; sharing history pending' },
  { module: 'agreements', status: 'partial', includes: 'authorized agreement/order projections, acceptance events and order-change history; audit records pending' },
  { module: 'assistant-goals', status: 'partial', includes: 'own personal goals/progress, authored personal reports and job subscriptions; agent negotiation and employer internals excluded' },
  { module: 'consultations', status: 'partial', includes: 'own requests and bookings through current owning projections, offerings and personal mentoring; historical reminders and availability pending' },
  { module: 'assistant', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'billing', status: 'partial', includes: 'own accounts, subscriptions, accepted prices, budgets and reservations; ledger and usage history pending' },
  { module: 'catalogue', status: 'partial', includes: 'all own offerings and versions with owning private-knowledge projection; audit history pending' },
  { module: 'communications', status: 'partial', includes: 'project/agreement threads, paginated own notifications, preferences and channels; other contexts pending' },
  { module: 'company', status: 'partial', includes: 'existing member projection; member directory not included' },
  { module: 'connections', status: 'partial', includes: 'own current connection/consent projections without bearer tokens; consent history pending' },
  { module: 'hubs', status: 'partial', includes: 'own legal-document acceptance history; operator records require separate owning projection' },
  { module: 'screening', status: 'partial', includes: 'own minimal compliance status; sensitive match/reviewer internals excluded' },
  { module: 'content', status: 'partial', includes: 'all owned publication working views with published versions and corrections; comment, wall and editorial history pending' },
  { module: 'execution', status: 'partial', includes: 'authorized confirmed agreement execution projections; full audit history pending' },
  { module: 'files', status: 'partial', includes: 'own authorized metadata and clean local bytes with digest checks; authenticated bounded streams include all clean local file sizes; external storage remains explicit' },
  { module: 'identity', status: 'partial', includes: 'person, emails, provider identities, memberships and all session views without token hashes; account-change history pending' },
  { module: 'plans', status: 'partial', includes: 'owner plans, all versions, item states, changes, timing, shares, locations, permits and diary; participation-only enumeration pending' },
  { module: 'privacy', status: 'supported', includes: 'own request and preference records' },
  { module: 'procurement', status: 'partial', includes: 'own needs, all RFQ versions and invitations; personal supplier invitations and pinned shared RFQ versions; company invitation history pending' },
  { module: 'profiles', status: 'supported', includes: 'owner profile, consents, licences, portraits, experience, preferences, follows, bookmarks and reading progress' },
  { module: 'projects', status: 'partial', includes: 'owned and currently participating project projections; ownership-transfer and participation history pending' },
  { module: 'reputation', status: 'partial', includes: 'own reputation builder including superseded credentials/checks and confirmation inbox; historical computed snapshots unavailable' },
  { module: 'sales', status: 'partial', includes: 'authorized buyer/seller quote versions, negotiation rounds and amendment requests; audit history pending' },
  { module: 'sources', status: 'unsupported', includes: 'verified unregistered intake and exact source resolution implemented separately; subject-wide source export needs a safe discovery port' },
  { module: 'support', status: 'partial', includes: 'all own cases, requester-visible notes/diagnostics, all own servicing actions and masked access records through owning projections' },
  { module: 'tasks', status: 'partial', includes: 'all own requests and their versions, offer groups and their versions, assignments and invitations through owning projections; historic private offer constraints limited to current owning projection' },
  { module: 'trust', status: 'partial', includes: 'confirmed agreement reviews and responses; historical reputation snapshots pending' },
] as const;

const MODULE_ALIASES: Readonly<Record<string, string>> = { transactions: 'agreements', directory: 'company', 'platform-admin': 'privacy' };
export const EXPORT_COVERAGE = PRIVACY_MODULE_INVENTORY.map((module) => {
  const entry = MODULE_COVERAGE.find((r) => r.module === (MODULE_ALIASES[module] ?? module));
  // The privacy exporter does not cover all administration records.
  return { module, status: module === 'platform-admin' ? 'partial' as const : entry?.status ?? 'unsupported' as const,
    includes: entry?.includes ?? 'owning module exporter unavailable; not omitted from the inventory' };
});

/** Reuses real services/serializers in the caller's transaction, never a maintenance identity or staff grant. */
class ExportPrincipals extends PrincipalService {
  constructor(ctx: AppContext, private readonly trx: Transaction, private readonly caller: Principal) { super(ctx); }
  override runAs<T>(_state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> { return fn(this.trx, this.caller); }
}

export async function composeExport(ctx: AppContext, identity: IdentityServices, trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject, fileOptions: FilesModuleOptions, owningPorts: PrivacyOwningPorts) {
  // A person export does not silently become an employer export. SQL remains under the real principal's RLS.
  const caller = subject.kind === 'person' ? { ...principal, membership: null } : principal;
  const principals = new ExportPrincipals(ctx, trx, caller);
  const readState = { ...state, principal: caller };
  const profile = new ProfilesService(ctx, principals, new NoProfileMandates());
  const projects = new ProjectsService(ctx, principals, identity.participations);
  const catalogue = new CatalogueService(ctx, principals, new NoCommerceMandates());
  const procurement = new ProcurementService(ctx, principals, identity.participations, new NoCommerceMandates());
  const sales = new SalesService(ctx, principals, identity.participations, new NoDealMandates(), new SellerStatedTax());
  const agreements = new TransactionsService(ctx, principals, identity.participations, new NoDealMandates(), new ConfiguredElectronicRecords());
  const owner = subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id';
  const party = subject.kind === 'person' ? 'person_id' : 'company_id';
  // Table and column names are server constants, never an input path or a caller-supplied query.
  const owned = async (table: 'project' | 'offering' | 'need' | 'rfq') => (await sql<{ id: string }>`SELECT id FROM ${sql.table(`trustwork.${table}`)} WHERE ${sql.ref(owner)} = ${subject.id}::uuid ORDER BY id`.execute(trx)).rows;
  const sided = async (table: 'quote' | 'agreement') => (await sql<{ id: string }>`SELECT id FROM ${sql.table(`trustwork.${table}`)} WHERE ${sql.ref(`buyer_${party}`)} = ${subject.id}::uuid OR ${sql.ref(`seller_${party}`)} = ${subject.id}::uuid ORDER BY id`.execute(trx)).rows;
  const data: Record<string, unknown> = {};
  if (subject.kind === 'person') {
    data.profiles = {
      profile: await profile.myProfile(readState), preferences: await profile.getPreferences(readState), follows: await profile.listFollows(readState),
      bookmarks: await profile.listBookmarks(readState), readingProgress: await profile.listReadingProgress(readState),
    };
  } else data.company = await new MembershipService(ctx, principals).company(subject.id, readState);
  const projectRows = await owned('project');
  const agreementRows = await sided('agreement');
  data.projects = await mapSequential(projectRows, (r) => projects.get(r.id, readState));
  const participationRows = await trx.selectFrom('object_participation').select('resource_id')
    .where('resource_kind', '=', 'project').where(subject.kind === 'person' ? 'party_person_id' : 'party_company_id', '=', subject.id)
    .where('revoked_at', 'is', null).where('valid_from', '<=', ctx.clock.now())
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', ctx.clock.now())]))
    .where(sql<boolean>`capabilities && ARRAY['read.shared', 'read.party_private', 'read.owner_private']::text[]`).orderBy('resource_id').execute();
  const participatingIds = [...new Set(participationRows.map((r) => r.resource_id))].filter((id) => !projectRows.some((r) => r.id === id));
  data.participatingProjects = await mapSequential(participatingIds, (id) => projects.get(id, readState));
  data.catalogue = await mapSequential(await owned('offering'), (r) => catalogue.get(r.id, null, readState));
  data.procurement = {
    needs: await mapSequential(await owned('need'), (r) => procurement.getNeed(r.id, readState)),
    rfqs: await mapSequential(await owned('rfq'), (r) => procurement.getRfq(r.id, readState)),
  };
  if (subject.kind === 'person') {
    const invitations = await procurement.listInvitations(readState);
    data.supplierInvitations = {
      ...invitations,
      rfqs: await mapSequential([...new Set(invitations.invitations.map((i) => i.rfq.id))], (id) => procurement.getRfq(id, readState)),
    };
  }
  data.sales = await mapSequential(await sided('quote'), (r) => sales.getQuote(r.id, readState));
  data.agreements = await mapSequential(agreementRows, (r) => agreements.getAgreement(r.id, readState));
  Object.assign(data, await composeModuleExports({ ctx, identity, fileOptions, owningPorts, trx, principals, principal: caller, state: readState, subject, projectIds: projectRows.map((r) => r.id), agreementIds: agreementRows.map((r) => r.id) }));
  return data;
}
async function mapSequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** Composition-root adapter: the privacy module sees only its port, never another module's service. */
export function privacyExportPort(ctx: AppContext, identity: IdentityServices, fileOptions: FilesModuleOptions, owningPorts: PrivacyOwningPorts) {
  return { coverage: EXPORT_COVERAGE,
    file: async (trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject, id: string, consume: (file: { stream: Readable; bytes: number; sha256: string }) => Promise<void>) => {
      const caller = subject.kind === 'person' ? { ...principal, membership: null } : principal;
      const principals = new ExportPrincipals(ctx, trx, caller);
      if (!fileOptions.store) throw new Error('file storage unavailable');
      const service = new FilesService(ctx, principals, identity.participations, { store: fileOptions.store, mandates: new NoFileMandates() });
      await withOwnPrivacyFile({ trx, state: { ...state, principal: caller }, subject, id, store: fileOptions.store, service }, consume);
    }, compose: (trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject) => composeExport(ctx, identity, trx, principal, state, subject, fileOptions, owningPorts) };
}
