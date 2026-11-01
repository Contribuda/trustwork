import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { sql } from 'kysely';
import type { DataPool, Transaction } from '@trustwork/data';
import { bookingFees } from '../../../packages/data/src/repositories/billing-fees.js';
import { rejects } from '../../hubs/helpers.js';
import type { feeWorld } from './helpers.js';

/** Real app-role calls. Roll back unexpected successes so a red POC does not poison later acceptance tests. */
export async function rawBindingChecks(t: TestContext, admin: DataPool, w: Awaited<ReturnType<typeof feeWorld>>, scopeId: string, destination: string, unrelated: string, sourceDigest: string) {
  const rollback = new Error('Unexpected raw binding succeeded; rolling back the POC');
  for (const [person, hub, otherPerson, otherHub] of [[w.p.outsider,w.hubA,w.p.operator,w.hubB],[w.p.operator,w.hubB,w.p.outsider,w.hubA]]) {
    const d = await w.a.as(person!, trx => bookingFees.disclose(trx,hub!,scopeId));
    const c = await w.a.as(person!, trx => bookingFees.confirm(trx,hub!,d.id,d.digest));
    const before = (await admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action='billing.fees_bound'")).rows[0].n;
    for (const [label,id] of [['unrelated real destination',unrelated],['nonexistent UUID',randomUUID()]]) {
      await t.test(`raw bind ${d.snapshot.side}: ${label} cannot consume a valid confirmation`, async()=>{
        await rejects(w.a.as(person!,async trx=>{await bookingFees.bind(trx,hub!,c.id,id!,sourceDigest);throw rollback;}),'23514','billing.source_outdated');
      });
    }
    await t.test(`raw bind ${d.snapshot.side}: other participant and other hub cannot consume it`,async()=>{
      await rejects(w.a.as(otherPerson!,trx=>bookingFees.bind(trx,otherHub!,c.id,destination,sourceDigest)),'P0002','admin.not_found');
      await rejects(w.a.as(person!,trx=>bookingFees.bind(trx,otherHub!,c.id,destination,sourceDigest)),'P0002','admin.not_found');
    });
    assert.equal((await admin.query('SELECT id FROM trustwork.billing_fee_confirmation WHERE id=$1',[c.id])).rowCount,1);
    assert.equal((await admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE confirmation_id=$1',[c.id])).rowCount,0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action='billing.fees_bound'")).rows[0].n,before);
    await t.test(`raw bind ${d.snapshot.side}: the exact real destination succeeds and a crash rolls back binding and audit`,async()=>{
      await assert.rejects(w.a.as(person!,async trx=>{
        await bookingFees.bind(trx,hub!,c.id,destination,sourceDigest);
        assert.equal((await sql<{n:number}>`SELECT count(*)::int AS n FROM trustwork.billing_fee_binding WHERE confirmation_id=${c.id}::uuid`.execute(trx)).rows[0]?.n,1);
        await sql`SAVEPOINT duplicate_binding`.execute(trx);
        await rejects(bookingFees.bind(trx,hub!,c.id,destination,sourceDigest),'23505');
        await sql`ROLLBACK TO SAVEPOINT duplicate_binding`.execute(trx);
        throw rollback;
      }),error=>error===rollback);
      assert.equal((await admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE confirmation_id=$1',[c.id])).rowCount,0);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action='billing.fees_bound'")).rows[0].n,before);
    });
    await t.test(`raw bind ${d.snapshot.side}: concurrent exact consumes have one winner and one audit`,async()=>{
      const results=await Promise.allSettled([1,2].map(()=>w.a.as(person!,trx=>bookingFees.bind(trx,hub!,c.id,destination,sourceDigest))));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const loser=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
      assert.equal(loser.reason.code,'23505');
      assert.equal((await admin.query('SELECT id FROM trustwork.billing_fee_binding WHERE confirmation_id=$1',[c.id])).rowCount,1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action='billing.fees_bound'")).rows[0].n,before+1);
    });
  }
}
export async function mustRefuseFinal(as: <T>(fn:(trx:Transaction)=>Promise<T>)=>Promise<T>, operation:(trx:Transaction)=>Promise<unknown>) {
  await rejects(as(async trx=>{await operation(trx);await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(trx);throw new Error('Fee-less final transition succeeded; rolling back POC');}),'23514','billing.unavailable');
}

export async function recordAcceptance(trx:Transaction, id:string, side:'buyer'|'seller') {
  const a=await trx.selectFrom('agreement').selectAll().where('id','=',id).executeTakeFirstOrThrow();
  const person=side==='buyer'?a.buyer_person_id:a.seller_person_id;
  await trx.insertInto('acceptance_event').values({agreement_id:id,kind:side==='buyer'?'buyer_accepts_terms':'seller_accepts_order',terms_kind:a.terms_kind,
    quote_version_id:null,rfq_version_id:null,offer_version:a.offer_version,offer_digest:a.offer_digest,request_version:a.request_version,request_digest:a.request_digest,
    accepted_terms_digest:a.accepted_terms_digest,actor_person_id:person!,on_behalf_person_id:person,on_behalf_company_id:null,via:'person',mandate_id:null,
    transaction_budget_id:null,reservation_id:null,platform_budget_id:null,e_records_required:false,e_records_disclosure_key:null,e_records_basis:[],e_records_consented_at:null,
    reason:null,idempotency_key:randomUUID()}).execute();
}
