import type { Transaction } from '../pool.js';
import type { NewObjectParticipation, NewPermissionGrant, ObjectParticipation, PermissionGrant, ResourceKind } from '../schema.js';

/**
 * Participation and grant rows. RLS shows a party its own rows (person directly, company through the
 * setter-derived active membership) and a grantor the rows it granted; capability and no-amplification
 * checks (`canGrant` in packages/contracts) are the application policy's job before calling `grant`.
 */
export const participations = {
  grant(trx: Transaction, participation: NewObjectParticipation): Promise<ObjectParticipation> {
    return trx.insertInto('object_participation').values(participation).returningAll().executeTakeFirstOrThrow();
  },
  revoke(trx: Transaction, id: string, expectedRevision: number, reason: string, at: Date = new Date()): Promise<ObjectParticipation | undefined> {
    return trx.updateTable('object_participation').set({ revoked_at: at, revoked_reason: reason }).where('id', '=', id).where('revision', '=', expectedRevision).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  listForResource(trx: Transaction, resourceKind: ResourceKind, resourceId: string): Promise<ObjectParticipation[]> {
    return trx.selectFrom('object_participation').selectAll().where('resource_kind', '=', resourceKind).where('resource_id', '=', resourceId).orderBy('valid_from').execute();
  },
  /** Live rows of the current principal's parties for one resource (RLS already filters to own parties). */
  liveForResource(trx: Transaction, resourceKind: ResourceKind, resourceId: string, now: Date = new Date()): Promise<ObjectParticipation[]> {
    return trx.selectFrom('object_participation').selectAll()
      .where('resource_kind', '=', resourceKind).where('resource_id', '=', resourceId)
      .where('revoked_at', 'is', null).where('valid_from', '<=', now)
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', now)]))
      .execute();
  },
};

export const permissionGrants = {
  grant(trx: Transaction, grant: NewPermissionGrant): Promise<PermissionGrant> {
    return trx.insertInto('permission_grant').values(grant).returningAll().executeTakeFirstOrThrow();
  },
  revoke(trx: Transaction, id: string, expectedRevision: number, reason: string, at: Date = new Date()): Promise<PermissionGrant | undefined> {
    return trx.updateTable('permission_grant').set({ revoked_at: at, revoked_reason: reason }).where('id', '=', id).where('revision', '=', expectedRevision).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  liveForPerson(trx: Transaction, personId: string, now: Date = new Date()): Promise<PermissionGrant[]> {
    return trx.selectFrom('permission_grant').selectAll().where('principal_person_id', '=', personId).where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)])).execute();
  },
};
