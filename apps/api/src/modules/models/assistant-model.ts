import type { ModelCall } from '../../../../../packages/contracts/src/models.js';
import { ApiError } from '../../common/errors.js';
import type { ModelInput, ModelPort, ModelReply } from '../assistant/ports.js';
import type { ModelGateway, GatewayResult } from './gateway.js';
import { ModelRefusal } from './ports.js';

/** Trusted runtime selection; no mandate, scope, price or permission is ever parsed out of the chat text. */
export interface AssistantModelContextPort {
  resolve(execution: NonNullable<ModelInput['execution']>): Promise<{ gateway: ModelGateway; call: Omit<ModelCall, 'prompt'> }>;
  recover(execution: NonNullable<ModelInput['execution']>): Promise<GatewayResult>;
}
const unavailable = (): ModelReply => ({
  text: null,
  messageKey: 'assistant.overlay.stateUnavailable',
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0 },
});
const reply = (result: GatewayResult): ModelReply | null =>
  result.outcome === 'outcome_unknown'
    ? null
    : {
        text: result.text,
        messageKey: result.text ? null : 'assistant.overlay.stateUnavailable',
        toolCalls: [],
        usage: { inputTokens: result.metadata?.inputTokens ?? 0, outputTokens: result.metadata?.outputTokens ?? 0 },
      };

/** Inject through the existing AssistantModule model option. Default remains unavailable until AGT authority exists. */
export class GatewayAssistantModel implements ModelPort {
  readonly provider = 'model_gateway';
  constructor(private readonly contexts: AssistantModelContextPort) {}
  private async context(input: ModelInput) {
    const execution = input.execution;
    if (!execution) throw new ModelRefusal('runtime_context_required');
    const resolved = await this.contexts.resolve(execution);
    const call = resolved.call;
    if (
      call.operationId !== execution.operationId ||
      call.runId !== execution.runId ||
      call.principalId !== execution.principal.personId ||
      call.principalId !== input.personId ||
      call.hubId !== execution.hubId
    )
      throw new ModelRefusal('authority_mismatch');
    // A person's conversation is private even when its text happens to discuss public material.
    if (!call.dataClasses.includes('person_private')) throw new ModelRefusal('conversation_classification_required');
    return resolved;
  }
  async respond(input: ModelInput): Promise<ModelReply> {
    try {
      const { gateway, call } = await this.context(input);
      // Caller content remains untrusted data, separate from runtime authority.
      const result = reply(await gateway.call({ ...call, prompt: JSON.stringify({ history: input.history, text: input.text, evidence: input.evidence }) }));
      if (!result) throw new ApiError('validation.idempotency_in_progress', 'model outcome unresolved');
      return result;
    } catch (error) {
      if (error instanceof ModelRefusal) return unavailable();
      throw error;
    }
  }
  async recover(input: ModelInput): Promise<ModelReply | null> {
    if (!input.execution || input.personId !== input.execution.principal.personId) throw new ModelRefusal('authority_mismatch');
    return reply(await this.contexts.recover(input.execution));
  }
}
