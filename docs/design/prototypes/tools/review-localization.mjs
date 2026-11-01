// Classify exact-English candidates from browser evidence. Unknown text fails this lexical review.
// This is not native-speaker review or proof of semantic/grammatical correctness.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),evidence=path.join(root,'evidence');
const loans={es:['Roles','Hub','Editor','Editorial','Auditor','General','Legal','Manual','Media','No','Total'],ru:[], 'uz-Latn':['Agent','Auditor','Moderator','Model','Format','Media','Operator'],ka:[],hy:[], 'az-Latn':['Agent','Auditor','Moderator','Model','Format','Region','Status','Status:','Operator','Regional operator','Media']};
const names=['San Diego, CA','Sam Lee','Sam Lee (sam.lee@example.org)','Alex Example','Maria Sample','El Cajon','Maria R.','Alex P.','Armenia','Australia','Georgia','India','Portugal','Coastline Roofing LLC','Mesa Vista Logistics LLC','EXAMPLE ROOFING COMPANY'];
const identifiers=['1 perm','API','Esc','Ctrl','Cron','ASTM C31','NAICS 238160 · PSC Z2AA','translation','classification','summarisation','embeddings, ocr','editorial_rewrite, summarisation','fact_check_assist','classification, agent_drafting','image_generation','summarisation, classification','editorial_translator.pretranslate','editorial_translator.translate','429 rate_limited'];
const report={status:'lexical review only; all translations remain unreviewed drafts',reviewed:[],unresolved:[],sourceLanguageExceptions:['Editorial translation source/target segments and glossary entries declare en/es.','Editorial collection query examples declare their source language.','Tender citation drawer quotes an English synthetic source with lang=en.','Recipient-language outreach previews and user-entered fixture text declare their language.']};
const candidates=[];const audit=JSON.parse(fs.readFileSync(path.join(evidence,'audit.json'),'utf8'));for(const c of audit.same)candidates.push({...c,text:c.s});
for(const file of fs.readdirSync(evidence).filter(f=>/^interactions-.*\.json$/.test(f))){const data=JSON.parse(fs.readFileSync(path.join(evidence,file),'utf8'));for(const c of data.same)candidates.push({...c,name:data.name});}
const seen=new Set();for(const c of candidates){const raw=c.text.replace(/^@[a-z-]+: /,'').replace(/^[›↔]\s*/,''),id=[c.name,c.tag,raw].join('|');if(seen.has(id))continue;seen.add(id);let reason;
 if(raw==='Trustwork')reason='Canonical international brand; Russian uses the repository overlay.';
 else if(raw==='Fixture QA'||raw==='hello')reason='Explicit test input, not interface copy.';
 else if(names.includes(raw)||/^(?:Synthetic (?:Owner|Commercial|Support|Moderator|Compliance|Auditor|Editor|Editor-in-chief|Reviewer) [A-H]|Synthetic Rosa Delgado|Synthetic Dana Ortiz)$/.test(raw))reason='Preserved synthetic proper name or place name.';
 else if(/^(?:Example |Sample |Placeholder |100 Example (?:St|Street), |22 Sample (?:Ave|Avenue), )/.test(raw))reason='Preserved invented entity/source/address name from the original fixture.';
 else if(identifiers.includes(raw)||/^(?:Writer-\d|Fact-\d|Triage-\d|Translate-ES|Scout-\d|Layout-\d|Ops-\d|example-(?:large|small)-\d|sample-translate-\d|fixture-open-\w+|INC-\d+|SEV-\d+|SYN-\d{4}-\d+)$/.test(raw))reason='Stable model, role, schema, incident or keyboard identifier.';
 else if(/^[\w.+-]+@[\w.-]+$|^[\w.-]+\.(?:invalid|org)$|^trustwork:\/\/|^[A-Z]{2}-[A-Z0-9-]+(?::[a-z-]+)?$/.test(raw))reason='Synthetic domain, address, URI or territory identifier.';
 else if(c.tag==='es'&&/^(?:Solicitation|Specifications)\.pdf, p\. \d+$/.test(raw))reason='Stable synthetic file name and Spanish page abbreviation from pageRef.';
 else if(/^\d+ \(federation\./.test(raw))reason='Numeric count and stable federation error identifiers.';
 else if(!/[a-z]/i.test(raw))reason='Punctuation or numeric output, not English copy.';
 else if(loans[c.tag]?.includes(raw)||c.tag==='es'&&/^\d+ min$/.test(raw))reason='Valid shared spelling/abbreviation in the target-language dictionary; native review still pending.';
 const item={prototype:c.name,locale:c.tag,text:raw,exampleState:c.state,reason};(reason?report.reviewed:report.unresolved).push(item);
}
fs.writeFileSync(path.join(evidence,'localization-review.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reviewed:report.reviewed.length,unresolved:report.unresolved}));if(report.unresolved.length)process.exitCode=1;
