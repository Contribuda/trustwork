import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root=process.cwd(); const errors=[];
// An exported engine tree (scripts/export-open-source.mjs) carries EXPORT-MANIFEST.json and no task graph, agent
// coordination or check evidence: those checks are skipped and links into the removed private paths are ignored.
const exported=existsSync('EXPORT-MANIFEST.json');
const privatePaths=exported?JSON.parse(readFileSync('EXPORT-MANIFEST.json','utf8')).excludes??[]:[];
const { validateTaskGraph } = exported ? { validateTaskGraph: () => [] } : await import('./task-graph.mjs');
const { validScope } = exported ? { validScope: () => true } : await import('./coordination.mjs');
const excluded=new Set(['.git','node_modules','.next','dist','work']);
function walk(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap((e)=> excluded.has(e.name)||e.name.startsWith('.next')?[]:e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]); }
const files=walk(root);
for(const file of files.filter((p)=>p.endsWith('.md'))) {
 const text=readFileSync(file,'utf8');
 for(const m of text.matchAll(/\]\(([^)]+)\)/g)) {
  let link=m[1].split(/\s+"/)[0].replace(/^<|>$/g,'');
  if(/^(https?:|mailto:|#)/.test(link)) continue;
  link=decodeURIComponent(link.split('#')[0]);
  if(link && !existsSync(resolve(dirname(file),link))) { const rel=relative(root,resolve(dirname(file),link)); if(!privatePaths.some((x)=>rel===x||rel.startsWith(`${x}/`))) errors.push(`Broken local link: ${relative(root,file)} -> ${link}`); }
 }
}
const graph=exported?{tasks:[]}:JSON.parse(readFileSync('tasks/graph.json','utf8'));const ids=new Set(graph.tasks.map((t)=>t.id));
const readEvidence=(sha)=>{const p=join('docs/operations/check-evidence',`${sha}.json`);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;};
errors.push(...validateTaskGraph(graph,{readEvidence}));
const marks=new Map();
function visit(id) { if(marks.get(id)==='active')throw new Error(`Task cycle at ${id}`);if(marks.get(id)==='done')return;const t=graph.tasks.find((t)=>t.id===id);if(!t)throw new Error(`Missing dependency ${id}`);marks.set(id,'active');t.dependencies.forEach(visit);marks.set(id,'done'); }
for(const t of graph.tasks) {
 for(const key of ['id','lane','title','status','paths','goal','inputs','researchEvidence','steps','outputs','acceptance','reviewer','handoff','brief'])if(!t[key] || (Array.isArray(t[key])&&!t[key].length))errors.push(`${t.id}: missing ${key}`);
 if(!existsSync(join('tasks',t.brief)))errors.push(`${t.id}: missing brief`);
 if(t.paths.some((p)=>!validScope(p)))errors.push(`${t.id}: noncanonical scope`);
 if(t.status==='accepted'&&!t.acceptanceEvidence)errors.push(`${t.id}: accepted without evidence`);
 try{visit(t.id);}catch(e){errors.push(e.message);}
}
const manifest=exported?{assets:[]}:JSON.parse(readFileSync('docs/design/manifest.json','utf8'));
for(const asset of manifest.assets) {
 const p=join('docs/design',asset.file);
 if(!existsSync(p))errors.push(`Missing reference ${p}`);
 else if(createHash('sha256').update(readFileSync(p)).digest('hex')!==asset.sha256)errors.push(`Reference checksum mismatch ${p}`);
 if(!asset.status||!asset.functionalCorrections||!asset.inspected)errors.push(`Incomplete reference ${asset.screenId}`);
}
if(!exported&&manifest.assets.find((x)=>x.screenId==='workspace-latest')?.status!=='proposed_unapproved')errors.push('Latest workspace approval must change only with recorded human evidence');
const locale=JSON.parse(readFileSync('packages/ui/locales/ru.json','utf8'));
if(JSON.stringify(locale.publicNav)!==JSON.stringify(['Главная','Новости','Статьи','События','Компании','Люди','Проекты','Журнал']))errors.push('Public navigation drift');
const trace=exported?{requirements:[]}:JSON.parse(readFileSync('docs/product/traceability.json','utf8'));
const specIds = [...readFileSync('docs/product/specification.md','utf8').matchAll(/^\| (R\d{2}) \|/gm)].map((m)=>m[1]);
if(!specIds.length || new Set(specIds).size!==specIds.length)errors.push('Missing or duplicate specification requirements');
const traceIds=trace.requirements.map((x)=>x.id);
if(new Set(traceIds).size!==traceIds.length)errors.push('Duplicate requirement trace');
if(!exported)for(const id of specIds)if(!traceIds.includes(id))errors.push(`Missing requirement trace ${id}`);
for(const id of traceIds)if(!specIds.includes(id))errors.push(`Unknown requirement trace ${id}`);
for(const row of trace.requirements)for(const id of row.tasks)if(!ids.has(id))errors.push(`Trace ${row.id}: unknown ${id}`);
for(const p of files.filter((p)=>p.endsWith('.json'))) { try{JSON.parse(readFileSync(p,'utf8'));}catch{errors.push(`Invalid JSON ${relative(root,p)}`);} }
for(const file of files.filter((p)=>statSync(p).size>50*1024*1024))errors.push(`Oversize file ${relative(root,file)}`);
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`Validated local Markdown targets, ${graph.tasks.length} task DAG nodes, ${manifest.assets.length} image checksums, ${specIds.length} requirements and locale invariants.`);
