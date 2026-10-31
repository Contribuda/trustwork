import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { Company, CompanyPrivate, Membership, MembershipRole, NewCompany, NewMembership } from '../schema.js';

export const companies = {
  insert(trx: Transaction, company: NewCompany): Promise<Company> {
    return trx.insertInto('company').values(company).returningAll().executeTakeFirstOrThrow();
  },
  getById(trx: Transaction, id: string): Promise<Company | undefined> {
    return trx.selectFrom('company').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** owner_private row (internal notes, billing account); visible only to members of the active employer. */
  getPrivate(trx: Transaction, companyId: string): Promise<CompanyPrivate | undefined> {
    return trx.selectFrom('company_private').selectAll().where('company_id', '=', companyId).executeTakeFirst();
  },
  upsertPrivate(trx: Transaction, companyId: string, patch: { internal_notes?: string | null; billing_account_id?: string | null }): Promise<CompanyPrivate> {
    return trx.insertInto('company_private').values({ company_id: companyId, ...patch })
      .onConflict((oc) => oc.column('company_id').doUpdateSet(patch)).returningAll().executeTakeFirstOrThrow();
  },
};

/**
 * Membership rows are historical: parties never change, status follows the contract transition table and
 * the database keeps one active employer per person (partial unique index). Authority checks (who may invite,
 * accept or end) are the application policy's job; these calls only express the row change.
 */
export const memberships = {
  invite(trx: Transaction, membership: Omit<NewMembership, 'status' | 'valid_from' | 'ended_at' | 'ended_by' | 'ended_reason'>): Promise<Membership> {
    return trx.insertInto('membership').values({ ...membership, status: 'invited' }).returningAll().executeTakeFirstOrThrow();
  },
  /** invited -> active; a second active membership fails with the unique violation 23505 (membership.already_employed). */
  activate(trx: Transaction, id: string, expectedRevision: number, validFrom: Date = new Date()): Promise<Membership | undefined> {
    return trx.updateTable('membership').set({ status: 'active', valid_from: validFrom }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  changeRole(trx: Transaction, id: string, expectedRevision: number, role: MembershipRole, permissions: string[]): Promise<Membership | undefined> {
    return trx.updateTable('membership').set({ role, permissions }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  /** active -> ended with actor and reason; the trigger bumps the person and company epochs. */
  end(trx: Transaction, id: string, expectedRevision: number, endedBy: string, reason: string, at: Date = new Date()): Promise<Membership | undefined> {
    return trx.updateTable('membership').set({ status: 'ended', ended_at: at, ended_by: endedBy, ended_reason: reason }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  listForPerson(trx: Transaction, personId: string): Promise<Membership[]> {
    return trx.selectFrom('membership').selectAll().where('person_id', '=', personId).orderBy('invited_at').execute();
  },
  listForCompany(trx: Transaction, companyId: string): Promise<Membership[]> {
    return trx.selectFrom('membership').selectAll().where('company_id', '=', companyId).orderBy('invited_at').execute();
  },
  activeForPerson(trx: Transaction, personId: string): Promise<Membership | undefined> {
    return trx.selectFrom('membership').selectAll().where('person_id', '=', personId).where('status', '=', 'active').executeTakeFirst();
  },
  getById(trx: Transaction, id: string): Promise<Membership | undefined> {
    return trx.selectFrom('membership').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /**
   * Membership end with the full revocation sequence as one owner-run statement (trustwork.end_membership): ends the row,
   * revokes the person's company-derived participations and company-scoped permission grants, bumps epochs and revokes
   * the person's admission scope. Raises 23000 with hint membership.permission_missing / membership.last_administrator
   * / membership.ended when not authorised, last administrator or not active.
   */
  async endWithRevocation(trx: Transaction, id: string, reason: string): Promise<MembershipEnded> {
    const { rows } = await sql<MembershipEnded>`SELECT * FROM trustwork.end_membership(${id}::uuid, ${reason})`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('end_membership returned no row');
    return row;
  },
};
export interface MembershipEnded { membership_id: string; person_id: string; company_id: string; revision: number; revoked_participations: number; revoked_grants: number; admission_epoch: string }
