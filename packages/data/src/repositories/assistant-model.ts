import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AssistantModelTurnRow } from '../schema/assistant-model.js';
export const assistantModelTurns = {
  async lockConversation(trx: Transaction, personId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'assistant.conversation:' + personId}, 0))`.execute(trx);
  },
  pending(trx: Transaction, personId: string) {
    return trx.selectFrom('assistant_model_turn').selectAll().where('person_id', '=', personId).where('state', '=', 'pending').execute();
  },
  forRun(trx: Transaction, runId: string) {
    return trx.selectFrom('assistant_model_turn').selectAll().where('run_id', '=', runId).executeTakeFirst();
  },
  async fence(trx: Transaction, id: string) {
    return (await sql<AssistantModelTurnRow>`SELECT * FROM trustwork.assistant_fence_model_turn(${id}::uuid)`.execute(trx)).rows[0]!;
  },
  async available(trx: Transaction, personId: string): Promise<boolean> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'assistant.conversation:' + personId}, 0))`.execute(trx);
    return !(await trx.selectFrom('assistant_model_turn').select('id').where('person_id', '=', personId).where('state', '=', 'pending').executeTakeFirst());
  },
  async begin(trx: Transaction, key: string, digest: string, text: string) {
    return (
      await sql<{
        result: { fresh: boolean; turn: AssistantModelTurnRow };
      }>`SELECT trustwork.assistant_begin_model_turn(${key},${digest},${text}) AS result`.execute(trx)
    ).rows[0]!.result;
  },
  get(trx: Transaction, id: string) {
    return trx.selectFrom('assistant_model_turn').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async lock(trx: Transaction, id: string) {
    // Serialize finalization with the owning helper; runtime roles have no direct UPDATE privilege.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'assistant.model.final:' + id}, 0))`.execute(trx);
    return this.get(trx, id);
  },
  async finish(trx: Transaction, id: string, result: unknown) {
    await sql`SELECT trustwork.assistant_finish_model_turn(${id}::uuid,${JSON.stringify(result)}::jsonb)`.execute(trx);
  },
};
