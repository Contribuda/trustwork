import type { PlansService } from '../plans/plans.service.js';
import { type ServiceCapabilityBinding, type ServiceCapabilityBindings } from './service-bindings.js';

const operation = (suffix: string): ServiceCapabilityBinding => ({
  capabilityId: `project_planner.${suffix}`,
  async company(trx, principal, args) {
    const projectId = args[0];
    if (typeof projectId !== 'string' || !/^[a-f0-9-]{36}$/i.test(projectId)) return null;
    const project = await trx.selectFrom('project').select('owner_company_id').where('id', '=', projectId).executeTakeFirst();
    return project && project.owner_company_id === principal.membership?.companyId ? project.owner_company_id : null;
  },
});

/** Read variants use the owning get-plan projection permission; mutations retain their exact published capability. */
export const PLAN_SERVICE_BINDINGS = {
  get: operation('get_plan'), getVersion: operation('get_plan'), listItemStates: operation('get_plan'), listChanges: operation('get_plan'),
  listShares: operation('get_plan'), getLocation: operation('get_plan'), listPermits: operation('get_plan'), listDiary: operation('get_plan'),
  sharedWithMe: operation('list_shared_items'), previewShare: operation('preview_share'), licensing: operation('list_licensing_notices'), timingFacts: operation('list_timing_facts'),
  create: operation('draft_plan'), createDraft: operation('draft_plan'), saveDraft: operation('draft_plan'), propose: operation('propose_version'),
  approve: operation('approve_version'), returnVersion: operation('return_version'), recordChange: operation('record_change'), decideChange: operation('decide_change'),
  share: operation('share_item'), revokeShare: operation('revoke_share'), updateItemState: operation('update_item_state'),
  recordPermit: operation('record_permit'), addDiaryEntry: operation('add_diary_entry'), setLocation: operation('set_location'),
  privacyShared: { boundary: 'first_party_control', reason: 'Own statutory privacy inventory remains available under disabled commercial policy; owning subject authorization and private projections still apply.' },
} satisfies ServiceCapabilityBindings<PlansService>;
