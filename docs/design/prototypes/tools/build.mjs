import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'source');
const tags=['en','es','ru','uz-Latn','ka','hy','az-Latn'];
const read=p=>fs.readFileSync(path.join(source,p),'utf8');
const json=p=>JSON.parse(read(p));
const repo=path.resolve(root,'../../..');
const brandBase=JSON.parse(fs.readFileSync(path.join(repo,'packages/ui/locales/en.json'),'utf8')).brand.name;
const brandRu=JSON.parse(fs.readFileSync(path.join(repo,'apps/web/brand/messages/ru.json'),'utf8')).brand.name;
const brands=Object.fromEntries(tags.map(tag=>[tag,tag==='ru'?brandRu:brandBase]));
fs.writeFileSync(path.join(source,'locales/brand.generated.json'),JSON.stringify(brands,null,2)+'\n');
function brand(value,tag){if(typeof value==='string')return value.replaceAll(brandBase,'{brand}').replaceAll(brandRu,'{brand}').replaceAll('{brand}',brands[tag]);if(Array.isArray(value))return value.map(v=>brand(v,tag));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,brand(v,tag)]));return value;}
function kit(){
 let code=read('l10n-work/src/kit.js');
 const common=Object.fromEntries(tags.map(tag=>[tag,json(`locales/${tag}/common.json`)]));
 for(const [name,field] of [['KIT','picker'],['CLDR','format'],['RELATIVE_UNITS','relative']])code=code.replace('/*@@'+name+'@@*/','const '+name+'='+JSON.stringify(Object.fromEntries(tags.filter(tag=>common[tag][field]).map(tag=>[tag,common[tag][field]])))+';');
 return code;
}
function table(name){return Object.fromEntries(tags.map(tag=>[tag,brand(json(`locales/${tag}/${name}.json`),tag)]));}
function write(name,html){if(/https?:\/\/[^\s"']+\.(?:woff|css|js)/.test(html))throw Error('External asset in '+name);fs.writeFileSync(path.join(root,name+'-prototype.html'),html);console.log('Built '+name);}
let html=read('console-v2-src/01-head.html').replace('/*FONTS*/',read('assets/fonts.css'));
const c=table('console');const T=Object.fromEntries(Object.keys(c.en).map(k=>[k,tags.map(tag=>c[tag][k])]));
html+=read('console-v2-src/02-i18n.js').replace('/*@@CONSOLE_MESSAGES@@*/','const T='+JSON.stringify(T)+';');
html+='<script>'+kit()+'</script>';
html+=read('console-v2-src/03-app.js').replace('</script>','')+read('console-v2-src/04-screens.js')+read('console-v2-src/05-shell.js')+read('console-v2-src/06-actions.js').replace('<script>','');
write('console',html);
write('operating-company',read('operating-company.html').replace('/*@@OPERATING_MESSAGES@@*/','const S='+JSON.stringify(table('operating-company'))+';').replace('/*@@KIT_JS@@*/',kit()));
for(const name of ['outreach','tender','network']){
 const msgs=Object.fromEntries(tags.map(tag=>[tag,brand(vm.runInNewContext('('+read(`l10n-work/msg/${name}/${tag}.js`)+')'),tag)]));
 html=read(`l10n-work/src/${name}.html`);
 for(const [marker,value] of [['/*@@KIT_CSS@@*/',read('l10n-work/src/kit.css')],['/*@@KIT_JS@@*/',kit()],['/*@@MESSAGES@@*/','const MESSAGES='+JSON.stringify(msgs)+';']])html=html.replace(marker,value);
 write(name,html);
}
const ed=table('editorial');const edKeys=Object.fromEntries(Object.entries(json('locales/en/editorial.json')).map(([k,v])=>[v,k]));
html=read('editorial.html').replace('/*@@MESSAGES@@*/','const MESSAGES='+JSON.stringify(ed)+'; const EDITORIAL_KEYS='+JSON.stringify(edKeys)+';').replace('/*@@KIT_JS@@*/',kit()).replace('/*@@KIT_CSS@@*/',read('l10n-work/src/kit.css'));
write('editorial',html);
