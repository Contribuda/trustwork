import { AGENT_CATALOG_EXAMPLES, type AgentCapability } from '@trustwork/contracts';
import { COMMERCE_CAPABILITIES } from '../../../packages/contracts/src/commerce.js';
import { DEAL_CAPABILITIES } from '../../../packages/contracts/src/deals.js';
import { FILE_CAPABILITIES } from '../../../packages/contracts/src/files.js';
import { PROJECT_PLANNER_CAPABILITIES } from '../../../packages/contracts/src/plans.js';
import { PROFILE_KEEPER_CAPABILITIES } from '../../../packages/contracts/src/profiles.js';
import { supplyAgentCapabilities } from '../../../packages/contracts/src/supply/capabilities.js';
import { TASK_MARKETPLACE_CAPABILITIES } from '../../../packages/contracts/src/tasks.js';
import { EXECUTION_EVIDENCE_CAPABILITIES } from '../../../apps/api/src/modules/execution/contracts.js';

/**
 * Every agent capability the engine declares today (ADR 010 decision 23), gathered from the module registries. New
 * modules add their list here or register a module suite (tests/agent-safety/modules) that checks its own list.
 */
export function allCapabilities(): AgentCapability[] {
  const lists: readonly (readonly AgentCapability[])[] = [
    AGENT_CATALOG_EXAMPLES.AgentCapability as readonly AgentCapability[],
    COMMERCE_CAPABILITIES.map((e) => e.capability),
    DEAL_CAPABILITIES.map((e) => e.capability),
    FILE_CAPABILITIES.map((e) => e.capability),
    supplyAgentCapabilities(),
    PROJECT_PLANNER_CAPABILITIES,
    PROFILE_KEEPER_CAPABILITIES,
    TASK_MARKETPLACE_CAPABILITIES,
    EXECUTION_EVIDENCE_CAPABILITIES,
  ];
  const seen = new Set<string>();
  const out: AgentCapability[] = [];
  for (const c of lists.flat()) {
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
