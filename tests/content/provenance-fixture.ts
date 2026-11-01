import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { computeDigest } from '@trustwork/contracts';
import type { Transaction } from '@trustwork/data';
import { publications, type ContentStaffContext } from '../../packages/data/src/repositories/content.js';
import { provenance, type ProvenanceContext } from '../../packages/data/src/repositories/provenance.js';
import type { ContentWorld } from './helpers.js';

/** Explicit migration of legacy synthetic test setup to the real declaration/correction workflow.
 * No production code imports this helper. Guard-negative tests call the unwrapped commands.
 * This does not create translation reviews, consent, source grants or runtime evidence.
 */
export function withProvenanceFixtures(w: ContentWorld) {
  async function context(trx: Transaction, staff: ContentStaffContext | import('../../packages/data/src/repositories/content.js').ContentCorrectionContext | null): Promise<ProvenanceContext> {
    const person=(await sql<{id:string}>`SELECT trustwork.current_person_id() AS id`.execute(trx)).rows[0]!.id;
    const key=Object.keys(w.people).find(key=>w.people[key as keyof typeof w.people]===person)!;
    return {sessionId:w.admin.sessions[key]!,requestId:`synthetic-prov-${randomUUID()}`,...staff};
  }
  async function declare(trx: Transaction, staff: ContentStaffContext | import('../../packages/data/src/repositories/content.js').ContentCorrectionContext | null,id:string) {
    const v=(await publications.versions(trx,id)).at(-1);if(!v)return;
    const previous=(await provenance.history(trx,id)).filter(r=>r.version_id===v.id).at(-1);
    const refs=v.source_refs as Array<{uri:string;sourceTime?:string;observedAt:string;license?:string}>;
    const digest=computeDigest({title:v.title,body:v.body,language:v.language,sourceRefs:refs.map(r=>({uri:r.uri,sourceTime:r.sourceTime??null,observedAt:r.observedAt,license:r.license??null})),eventTime:v.event_time?new Date(v.event_time).toISOString():null,correctionOf:v.correction_of,correctionNote:v.correction_note});
    if(previous?.version_digest===digest.value && (v.status==='published'||previous.version_revision===v.revision))return;
    const assisted=v.assistant_assisted || (await publications.authorship(trx,id)).some(a=>a.assistant_assisted);
    await provenance.declare(trx,await context(trx,staff),{binding:{publicationId:id,version:v.version,digest},expectedRevision:previous?.revision??0,kind:assisted?'ai_assisted':'none',roles:assisted?['editorial_writer']:[],evidence:'human_declaration',original:null,reason:'Synthetic legacy fixture declaration'});
  }
  return {
    declare,
    async publish(...args: Parameters<typeof publications.publish>) {
      const [trx,staff,id]=args;await declare(trx,staff,id);return publications.publish(...args);
    },
    async correct(...args: Parameters<typeof publications.correct>) {
      const [trx,staff,id,revision,draft,note,reason]=args;
      const row=(await sql<{revision:number}>`SELECT revision FROM trustwork.provenance_prepare_correction(${JSON.stringify(await context(trx,staff))}::jsonb,${id}::uuid,${revision},${JSON.stringify(draft)}::jsonb,${note})`.execute(trx)).rows[0]!;
      await declare(trx,staff,id);
      return publications.correct(trx,await context(trx,staff),id,row.revision,draft,note,reason);
    },
  };
}

/** Prepare a declaration through the actual first-party API, without changing the client or bypassing guards. */
export async function declareHttpFixture(client: import('../backend/helpers/app.js').Client,id: string,staff?: {reason:string}) {
  const { ProvenanceWorkspaceSchema } = await import('../../packages/contracts/src/provenance.js');
  const { ok } = await import('./http.js');
  const view=ProvenanceWorkspaceSchema.parse(ok(await client.get(`/v1/provenance/publications/${id}`)));
  ok(await client.post('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision:view.record?.revision??0,kind:view.draft.assistantAssisted?'ai_assisted':'none',roles:view.draft.assistantAssisted?['editorial_writer']:[],evidence:'human_declaration',original:null,reason:'Synthetic API fixture declaration'},...(staff?{staff}:{})}),201);
  return view;
}
