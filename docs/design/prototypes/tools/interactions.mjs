import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import * as continuation from './scenarios.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(path.resolve(process.env.PROTOTYPE_DEPS||'.','package.json'))('playwright');
const names=process.argv.slice(2).length?process.argv.slice(2):['console','editorial','outreach','network','tender','operating-company'];
const tags=process.env.PROTOTYPE_LOCALES?.split(',')||['en','es','ru','uz-Latn','ka','hy','az-Latn'];
const widths=process.env.PROTOTYPE_WIDTHS?.split(',').map(Number)||[1280,375];
const allTags=['en','es','ru','uz-Latn','ka','hy','az-Latn'];
const browser=await chromium.launch();let failed=false;
function collect(){
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const texts=[];const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
 while(n=walk.nextNode()){const e=n.parentElement;if(!e||/^(SCRIPT|STYLE|OPTION)$/.test(e.tagName)||!visible(e)||e.closest('.lp-pop'))continue;const foreign=e.closest('[lang]');if(foreign&&foreign!==document.documentElement&&foreign.lang!==document.documentElement.lang)continue;const t=n.textContent.replace(/\s+/g,' ').trim();if(t)texts.push(t);}
 for(const e of document.querySelectorAll('[aria-label],[placeholder],[title],[data-label],[data-h]'))if(visible(e)&&!e.closest('.lp-pop'))for(const a of ['aria-label','placeholder','title','data-label','data-h'])if(e.getAttribute(a))texts.push('@'+a+': '+e.getAttribute(a));
 const unlabelled=[...document.querySelectorAll('button,input,select,textarea')].filter(e=>visible(e)&&e.type!=='hidden'&&!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')&&!e.innerText?.trim()).map(e=>e.outerHTML.slice(0,180));
 return {texts,unlabelled,scrollWidth:document.documentElement.scrollWidth,width:innerWidth,focus:document.activeElement?.outerHTML.slice(0,140)};
}
async function language(p,name,tag,width){
 if(name==='console'){if(width===375){await p.click('#userBtn');await p.locator('select[data-in=lang]:visible').selectOption(String(allTags.indexOf(tag)));}else await p.selectOption('#langTop',String(allTags.indexOf(tag)));}
 else if(name==='operating-company')await p.selectOption('#lang',tag);
 else {await p.click('.lp-btn');await p.click(`[data-lp="${tag}"]`);}
 assert.equal(await p.evaluate(()=>document.documentElement.lang),tag);
}
for(const name of names){
 const states=['outreach','tender'].includes(name)?(await import(`../source/l10n-work/tools/scenarios/${name}.mjs`)).states:continuation[name==='operating-company'?'operatingCompany':name];
 const report={name,checks:0,errors:[],overflow:[],unlabelled:[],network:[],keyboard:[],same:[],texts:[],screenshots:[]};const reference={};
 for(const width of widths)for(const tag of tags){const ctx=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});const p=await ctx.newPage();p.setDefaultTimeout(3500);
 await p.route('**/*',r=>{if(/^(file|data|about|blob):/.test(r.request().url()))return r.continue();report.network.push(r.request().url());return r.abort();});
 p.on('pageerror',e=>report.errors.push({width,tag,error:e.message}));p.on('console',m=>{if(['error','warning'].includes(m.type()))report.errors.push({width,tag,error:m.text()});});
 try{await p.goto('file://'+path.join(root,name+'-prototype.html'));await language(p,name,tag,width);await p.reload();assert.equal(await p.evaluate(()=>document.documentElement.lang),tag);
 for(const state of states){try{await state.run(p,tag);await p.waitForTimeout(state.wait||50);
 if(state.name.includes('dialog')&&await p.locator('dialog[open],[role=dialog][aria-modal=true]:visible').count()){
  const modal=p.locator('dialog[open],[role=dialog][aria-modal=true]:visible').last();assert(await modal.evaluate(e=>e.contains(document.activeElement)));
  await p.keyboard.press('Shift+Tab');assert(await modal.evaluate(e=>e.contains(document.activeElement)));
  await p.keyboard.press('Tab');assert(await modal.evaluate(e=>e.contains(document.activeElement)));
 }
 if((name==='outreach'&&state.name==='page')||(name==='tender'&&state.name==='overview')||(name==='network'&&state.name==='peer')){
  const selected=p.locator('[role=tab][aria-selected=true]').last();const label=await selected.innerText();await selected.focus();await p.keyboard.press('ArrowRight');assert.notEqual(await p.locator('[role=tab][aria-selected=true]').last().innerText(),label);await p.keyboard.press('ArrowLeft');assert.equal(await p.locator('[role=tab][aria-selected=true]').last().innerText(),label);
 }
 const data=await p.evaluate(collect);report.checks++;
 if(data.scrollWidth>width+1)report.overflow.push({width,tag,state:state.name,scrollWidth:data.scrollWidth});
 if(data.unlabelled.length)report.unlabelled.push({width,tag,state:state.name,controls:data.unlabelled});
 if(width===widths[0]){report.texts.push({tag,state:state.name,texts:data.texts});if(tag==='en')reference[state.name]=new Set(data.texts);else for(const t of data.texts)if(/[a-z]{3}/i.test(t)&&reference[state.name]?.has(t))report.same.push({tag,state:state.name,text:t});}
 if(tag==='ru'&&width===375&&/dialog|blocked|reason-required|activation|paid-ranking|handover-5|submitted|campaign-dry-strict/.test(state.name)){const dest=`evidence/${name}-ru-375-${state.name}.png`;await p.screenshot({path:path.join(root,dest),fullPage:true});report.screenshots.push(dest);}
 }catch(e){report.errors.push({width,tag,state:state.name,error:e.message});break;}}
 // Language menus must support keyboard, Escape and persistence independently of scenario mutations.
 await p.goto('file://'+path.join(root,name+'-prototype.html'));await language(p,name,'en',width);
 if(!['console','operating-company'].includes(name)){await p.focus('.lp-btn');await p.keyboard.press('Enter');assert.equal(await p.locator(':focus').getAttribute('data-lp'),'en');await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');assert.equal(await p.evaluate(()=>document.documentElement.lang),'es');assert(await p.locator('.lp-btn').evaluate(e=>e===document.activeElement));await p.keyboard.press('Enter');await p.keyboard.press('Escape');assert(await p.locator('.lp-pop').isHidden());assert(await p.locator('.lp-btn').evaluate(e=>e===document.activeElement));}
 else await language(p,name,'es',width);
 await p.reload();assert.equal(await p.evaluate(()=>document.documentElement.lang),'es');report.keyboard.push({width,tag,ok:true});
 }catch(e){report.errors.push({width,tag,error:e.message});}await ctx.close();}
 const output=path.join(root,`evidence/interactions-${name}.json`);fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 const counts=Object.fromEntries(Object.entries(report).filter(([k])=>k!=='texts').map(([k,v])=>[k,Array.isArray(v)?v.length:v]));console.log(JSON.stringify(counts));
 if(report.errors.length||report.overflow.length||report.unlabelled.length||report.network.length)failed=true;
}
await browser.close();if(failed)process.exitCode=1;
