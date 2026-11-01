/**
 * Existing public projections and first-party safety/consent controls are not purchasable capabilities.
 * This list affects availability only: owning RLS, consent, current identity and human-only handoffs still apply.
 * Unknown entries never inherit a boundary from their prefix or action name.
 */
export const NON_PURCHASABLE_CAPABILITIES: ReadonlySet<string> = new Set([
  'consultation.list_public_offerings',
  'core.get_goal_confirmation', 'core.confirm_goal', 'core.set_goal_status', 'core.share_report',
  'core.list_job_subscriptions', 'core.set_job_subscription_status', 'core.list_escalations', 'core.resolve_escalation',
  'profile_keeper.get_public_profile', 'profile_keeper.set_visibility', 'profile_keeper.grant_consent',
  'profile_keeper.withdraw_consent', 'profile_keeper.set_portrait',
  'representative.list_my_company_mandates', 'representative.get', 'representative.configure', 'representative.accept',
  'representative.suspend', 'representative.resume', 'representative.disable', 'representative.list_company_mandates',
  'representative.grant_company_mandate', 'representative.reconfirm_company_mandate', 'representative.revoke_company_mandate',
  'reputation_builder.view_public_reputation', 'reputation_builder.withdraw_confirmation_request',
  'reputation_builder.answer_confirmation_request', 'reputation_builder.declare_relation',
  'reputation_builder.submit_appeal', 'reputation_builder.appeal_limitation',
]);
