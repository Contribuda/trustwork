import { sql } from 'kysely';
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
export const EXPORT_COVERAGE = [
  { module: 'agreements', status: 'partial', includes: 'current authorized agreement/order projections; historical events not yet composed' },
  { module: 'assistant', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'billing', status: 'unsupported', includes: 'active worker owns the integration seam' },
  { module: 'catalogue', status: 'partial', includes: 'authorized offering view; historical versions not yet composed' },
  { module: 'communications', status: 'unsupported', includes: 'active CONS worker owns the integration seam' },
  { module: 'company', status: 'partial', includes: 'existing member projection; member directory not included' },
  { module: 'content', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'execution', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'files', status: 'unsupported', includes: 'binary artifact export not composed' },
  { module: 'identity', status: 'partial', includes: 'profile identity; credentials and session secrets never included' },
  { module: 'plans', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'privacy', status: 'supported', includes: 'own request and preference records' },
  { module: 'procurement', status: 'partial', includes: 'own needs and RFQs; supplier invitation views not yet composed' },
  { module: 'profiles', status: 'supported', includes: 'owner profile, consents, licences, portraits, experience, preferences, follows, bookmarks and reading progress' },
  { module: 'projects', status: 'partial', includes: 'owned project projections; participation-only projects not yet composed' },
  { module: 'reputation', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'sales', status: 'partial', includes: 'authorized buyer/seller quote views; historical versions not yet composed' },
  { module: 'sources', status: 'unsupported', includes: 'nonparticipant identity proof and sourced-record projection seam pending' },
  { module: 'support', status: 'unsupported', includes: 'requires case-specific exporter' },
  { module: 'tasks', status: 'unsupported', includes: 'requires owning-module exporter' },
  { module: 'trust', status: 'unsupported', includes: 'requires owning-module exporter' },
] as const;

/** Reuses real services/serializers in the caller's transaction, never a maintenance identity or staff grant. */
class ExportPrincipals extends PrincipalService {
  constructor(ctx: AppContext, private readonly trx: Transaction, private readonly caller: Principal) { super(ctx); }
  override runAs<T>(_state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> { return fn(this.trx, this.caller); }
}

export async function composeExport(ctx: AppContext, identity: IdentityServices, trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject) {
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
  data.projects = await mapSequential(await owned('project'), (r) => projects.get(r.id, readState));
  data.catalogue = await mapSequential(await owned('offering'), (r) => catalogue.get(r.id, null, readState));
  data.procurement = {
    needs: await mapSequential(await owned('need'), (r) => procurement.getNeed(r.id, readState)),
    rfqs: await mapSequential(await owned('rfq'), (r) => procurement.getRfq(r.id, readState)),
  };
  data.sales = await mapSequential(await sided('quote'), (r) => sales.getQuote(r.id, readState));
  data.agreements = await mapSequential(await sided('agreement'), (r) => agreements.getAgreement(r.id, readState));
  return data;
}
async function mapSequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** Composition-root adapter: the privacy module sees only its port, never another module's service. */
export function privacyExportPort(ctx: AppContext, identity: IdentityServices) {
  return { coverage: EXPORT_COVERAGE, compose: (trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject) => composeExport(ctx, identity, trx, principal, state, subject) };
}
