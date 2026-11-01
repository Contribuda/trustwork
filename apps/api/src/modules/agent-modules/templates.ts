/** Engine execution semantics. Hub JSON can narrow these actions, never provide code, tools or prompts. */
export const ENGINE_JOB_IMPLEMENTATIONS = [{
  moduleKey: 'core', templateKey: 'goal_progress_report', version: 1,
  capabilityId: 'core.generate_goal_report', action: 'prepare',
  sourceKinds: ['schedule', 'request', 'event', 'goal', 'deadline'],
}] as const;

export function jobImplementation(moduleKey: string, templateKey: string) {
  return ENGINE_JOB_IMPLEMENTATIONS.find((entry) => entry.moduleKey === moduleKey && entry.templateKey === templateKey) ?? null;
}
