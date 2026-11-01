import test from 'node:test';
import assert from 'node:assert/strict';
import { JurisdictionSourceSchema, ExecutableJurisdictionPayloadSchema } from '../../../packages/contracts/src/jurisdiction.js';
import { AgentLawFactSchema } from '../../../packages/country-packs/src/facets.js';
import { RepositoryJurisdictionPacks } from '../../../apps/api/src/modules/hubs/jurisdiction/pack-source.js';
import { sourceDocument } from './authority-fixture.js';

test('mandatory/advisory classification, provenance and counsel identities are required, not inferred from prose',()=>{
 const source=sourceDocument();assert.ok(JurisdictionSourceSchema.safeParse(source).success);
 for(const change of [
   {mandatoryAreas:[],advisoryAreas:[]}, {advisoryAreas:['consent']}, {provenance:[]}, {counsel:{status:'pending'}},
   {verification:'secondary'}, {ancestors:['US']}, {effectiveUntil:'2019-01-01T00:00:00.000Z'},
 ])assert.equal(JurisdictionSourceSchema.safeParse({...source,...change}).success,false);
 const explicitAbsence=structuredClone(source);explicitAbsence.policy.consentRequirements=[];
 assert.ok(JurisdictionSourceSchema.safeParse(explicitAbsence).success);
 const fact={id:'synthetic',topic:'other',summary:{en:'Synthetic fixture'},verification:'pending',sources:[{url:'https://example.invalid',what:'Synthetic',accessed:'2020-01-01'}],counselReview:'pending'};
 assert.ok(AgentLawFactSchema.safeParse(fact).success);
 assert.equal(ExecutableJurisdictionPayloadSchema.safeParse({agentSettings:{schemaVersion:2,jurisdictions:[]}}).success,false);
});
test('all shipped real-country policies remain UNKNOWN; source verification labels are preserved',()=>{
 const source=new RepositoryJurisdictionPacks();
 for(const code of ['US','US-CA','GB','CA','MX','UZ','GE','AM','AZ']){
   const result=source.inspect(code);assert.equal(result.baseline.status,'unknown',code);assert.equal(result.executableSource,undefined);
 }
});
