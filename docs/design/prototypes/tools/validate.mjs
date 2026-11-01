// Static acceptance: dictionaries, script syntax, deterministic generation and original preservation.
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tags=['en','es','ru','uz-Latn','ka','hy','az-Latn'];const names=['console','editorial','outreach','network','tender','operating-company'];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={dictionaries:[],artifacts:[],originals:{checked:0,mismatches:[]},errors:[],reproducible:false};
function flatten(v,prefix='',out={}){if(v&&typeof v==='object'&&!Object.keys(v).every(k=>['zero','one','two','few','many','other'].includes(k)))for(const [k,x] of Object.entries(v))flatten(x,prefix?prefix+'.'+k:k,out);else out[prefix]=v;return out;}
function messages(name,tag){return ['outreach','network','tender'].includes(name)?vm.runInNewContext('('+read(`source/l10n-work/msg/${name}/${tag}.js.fragment`)+')'):JSON.parse(read(`source/locales/${tag}/${name}.json`));}
const vars=s=>[...new Set((typeof s==='string'?s:s&&typeof s==='object'?Object.values(s).join(' '):'').matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g).map(m=>m[1]))].sort().join(',');
for(const name of names){const en=flatten(messages(name,'en'));for(const tag of tags){const m=flatten(messages(name,tag));const missing=Object.keys(en).filter(k=>!(k in m)),extra=Object.keys(m).filter(k=>!(k in en));const placeholders=Object.keys(en).filter(k=>k in m&&vars(en[k])!==vars(m[k]));if(missing.length||extra.length||placeholders.length)report.errors.push({name,tag,missing,extra,placeholders});report.dictionaries.push({name,tag,keys:Object.keys(m).length});}
 const file=path.join(root,`${name}-prototype.html`),html=fs.readFileSync(file,'utf8');let scripts=0;for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){try{new vm.Script(match[1]);scripts++;}catch(e){report.errors.push({name,error:e.message});}}
 if(/\/\*@@[A-Z_]+@@\*\//.test(html))report.errors.push({name,error:'Unexpanded generation marker'});
 if(/<(?:script|link|img|iframe)\b[^>]*(?:src|href)=["']https?:/i.test(html))report.errors.push({name,error:'External resource'});
 report.artifacts.push({name,scripts,sha256:hash(file)});
}
const before=report.artifacts.map(x=>x.sha256);const build=()=>{const r=spawnSync(process.execPath,[path.join(root,'tools/build.mjs')],{encoding:'utf8'});if(r.status!==0)report.errors.push({build:r.stderr||r.stdout});return names.map(n=>hash(path.join(root,n+'-prototype.html')));};
const first=build(),second=build();report.reproducible=JSON.stringify(before)===JSON.stringify(first)&&JSON.stringify(first)===JSON.stringify(second);if(!report.reproducible)report.errors.push({error:'Generated artifacts were stale or generation is not deterministic'});
if(process.env.PROTOTYPE_ORIGINALS){for(const entry of JSON.parse(read('source/original-inventory.json'))){const p=path.join(process.env.PROTOTYPE_ORIGINALS,entry.path);report.originals.checked++;if(!fs.existsSync(p)||hash(p)!==entry.sha256)report.originals.mismatches.push(entry.path);}if(report.originals.mismatches.length)report.errors.push({error:'Original file changed'});}
const manifest={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else manifest[path.relative(root,p)]=hash(p);}}walk(path.join(root,'source'));walk(path.join(root,'tools'));for(const n of names)manifest[n+'-prototype.html']=hash(path.join(root,n+'-prototype.html'));
fs.writeFileSync(path.join(root,'evidence/artifact-sha256.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(root,'evidence/source-validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({dictionaries:report.dictionaries.length,artifacts:report.artifacts.length,originals:report.originals.checked,reproducible:report.reproducible,errors:report.errors}));if(report.errors.length)process.exitCode=1;
