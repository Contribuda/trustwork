import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { LeadershipAssignment, NewOwnershipTransfer, NewProject, OwnershipTransfer, OwnershipTransferStatus, Project, ProjectUpdate } from '../schema.js';

/** Project rows: XOR owner, creator and leader are distinct columns; transfer and leadership are separate histories. */
export const projects = {
  insert(trx: Transaction, project: NewProject): Promise<Project> {
    return trx.insertInto('project').values(project).returningAll().executeTakeFirstOrThrow();
  },
  getById(trx: Transaction, id: string): Promise<Project | undefined> {
    return trx.selectFrom('project').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Optimistic update of the mutable columns (name, summary, status, publicity, notes); never the owner columns. */
  update(trx: Transaction, id: string, expectedRevision: number, patch: ProjectUpdate): Promise<Project | undefined> {
    return trx.updateTable('project').set(patch).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  /** Leader change with revision check; transfers nothing (ownership stays as is). */
  setLeader(trx: Transaction, id: string, expectedRevision: number, leaderPersonId: string | null): Promise<Project | undefined> {
    return trx.updateTable('project').set({ leader_person_id: leaderPersonId }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  /**
   * Ownership moves only through an accepted transfer applied by the current owner (SECURITY DEFINER
   * trustwork.apply_ownership_transfer); the runtime role has no UPDATE privilege on the owner columns.
   * Raises SQLSTATE 23000 with hint projects.transfer_* when not authorised, not consented or expired.
   */
  async applyOwnershipTransfer(trx: Transaction, transferId: string): Promise<Project> {
    const { rows } = await sql<Project>`SELECT * FROM trustwork.apply_ownership_transfer(${transferId}::uuid)`.execute(trx);
    const project = rows[0];
    if (!project) throw new Error('apply_ownership_transfer returned no row');
    return project;
  },
  /** Applies the accepted transfer AND re-materialises the owner participation row (revoke old, insert new). */
  async finalizeOwnershipTransfer(trx: Transaction, transferId: string): Promise<Project> {
    const { rows } = await sql<Project>`SELECT * FROM trustwork.finalize_ownership_transfer(${transferId}::uuid)`.execute(trx);
    const project = rows[0];
    if (!project) throw new Error('finalize_ownership_transfer returned no row');
    return project;
  },
};

export const ownershipTransfers = {
  propose(trx: Transaction, transfer: NewOwnershipTransfer): Promise<OwnershipTransfer> {
    return trx.insertInto('ownership_transfer').values(transfer).returningAll().executeTakeFirstOrThrow();
  },
  /** Status transition; the database trigger rejects anything outside the contract table. */
  transition(trx: Transaction, id: string, expectedRevision: number, status: OwnershipTransferStatus, at: Date = new Date()): Promise<OwnershipTransfer | undefined> {
    const patch = status === 'accepted_by_recipient' ? { status, recipient_consent_at: at } : status === 'effective' ? { status, effective_at: at } : { status };
    return trx.updateTable('ownership_transfer').set(patch).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  listForProject(trx: Transaction, projectId: string): Promise<OwnershipTransfer[]> {
    return trx.selectFrom('ownership_transfer').selectAll().where('project_id', '=', projectId).orderBy('proposed_at').execute();
  },
  getById(trx: Transaction, id: string): Promise<OwnershipTransfer | undefined> {
    return trx.selectFrom('ownership_transfer').selectAll().where('id', '=', id).executeTakeFirst();
  },
};

export const leadershipAssignments = {
  /** Ends the current assignment (if any) and starts a new one; one open row per project (partial unique index). */
  async assign(trx: Transaction, projectId: string, leaderPersonId: string, assignedBy: string, at: Date = new Date()): Promise<LeadershipAssignment> {
    await trx.updateTable('leadership_assignment').set({ ended_at: at, ended_by: assignedBy }).where('project_id', '=', projectId).where('ended_at', 'is', null).execute();
    return trx.insertInto('leadership_assignment').values({ project_id: projectId, leader_person_id: leaderPersonId, assigned_by: assignedBy, assigned_at: at }).returningAll().executeTakeFirstOrThrow();
  },
  history(trx: Transaction, projectId: string): Promise<LeadershipAssignment[]> {
    return trx.selectFrom('leadership_assignment').selectAll().where('project_id', '=', projectId).orderBy('assigned_at').execute();
  },
};
