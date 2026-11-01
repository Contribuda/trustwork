/* ================= Shell ================= */
function topbar(){const w=waitingForMe().length;const unread=S.notifications.filter(n=>!n.read).length;
 return `<header class="topbar">
 <button class="iconbtn menubtn" data-act="sidenav" aria-label="${esc(t('menu'))}" aria-expanded="false" aria-controls="side" id="menuBtn">${ic('menu')}</button>
 <a class="brand" href="${href('home','overview')}" aria-label="${esc(t('brandName')+' · '+t('admin'))}">${MARK}<span>${esc(t('brandName'))}</span><span class="adm">${esc(t('admin'))}</span></a>
 <span class="ctx"><span class="node"><a href="#/node" title="${esc(t('nodeConsole'))}">${esc(t('nodeLbl'))}: us-west-1</a> <span aria-hidden="true">/</span></span> <strong>${esc(t('hubName'))}</strong> <span class="b warn nodot">${esc(t('demo'))}</span>${hint(t('demoTip'))}</span>
 <span class="grow"></span>
 <button class="searchbtn" data-act="palette" id="searchBtn" aria-label="${esc(t('search'))}" aria-keyshortcuts="Control+K Meta+K">${ic('search','sm')}<span>${esc(t('search'))}</span><kbd>${MODK} K</kbd></button>
 <span class="grow hide-sm"></span>
 <a class="iconbtn" href="${href('home','approvals')}" id="apBtn" aria-label="${esc(t('approvals'))}${w?' ('+fN(w)+')':''}">${ic('approve')}${w?`<span class="dotcount" aria-hidden="true" id="apCount">${fN(w)}</span>`:''}</a>
 <button class="iconbtn" data-act="notif" id="ntBtn" aria-haspopup="true" aria-expanded="false" aria-label="${esc(t('notifications'))}${unread?' ('+fN(unread)+')':''}">${ic('bell')}${unread?`<span class="dotcount" aria-hidden="true">${fN(unread)}</span>`:''}</button>
 <button class="iconbtn hide-sm" data-act="shortcuts" id="helpBtn" aria-label="${esc(t('help'))}">${ic('help')}</button>
 <label class="vh" for="langTop">${esc(t('language'))}</label><select class="langsel top" id="langTop" data-in="lang">${langOptions()}</select>
 <button class="iconbtn" data-act="user" id="userBtn" aria-haspopup="true" aria-expanded="false" aria-label="${esc(ME)}"><span class="avatar" aria-hidden="true">OA</span></button>
 </header>`;}
const langOptions=()=>LANGS.map(([c,n],i)=>`<option value="${i}" lang="${c}" ${i===li?'selected':''}>${esc(n)}${i>=1?' · '+T.machineDraft[i]:''}</option>`).join('');
function sidebar(){const r=S.route;
 let h=`<aside class="side" id="side" aria-label="${esc(t('mainNav'))}"><nav aria-label="${esc(t('mainNav'))}"><ul class="nav">`;
 for(const s of NAV){const cur=r.sec===s.id;const cnt=s.id==='home'?waitingForMe().length:0;
  h+=`<li><a class="nt" href="${href(s.id,s.items[0][0])}" ${cur?'aria-current="true"':''} data-navtip="${esc(t(s.label))}" id="nt-${s.id}">${ic(s.icon)}<span class="lbl">${esc(t(s.label))}</span>${cnt?`<span class="cnt" aria-label="${fN(cnt)}">${fN(cnt)}</span>`:''}</a>`;
  if(cur){h+=`<ul class="sub">`;for(const [id,l] of s.items){const c=navCount(s.id,id);const built=BUILT.has(s.id+'/'+id);h+=`<li><a href="${href(s.id,id)}" ${r.item===id?'aria-current="page"':''} id="ns-${s.id}-${id}"><span>${esc(t(l))}</span>${c?`<span class="tag num" data-navcount="${s.id}/${id}">${fN(c)}</span>`:built?'':`<span class="tag">·</span>`}</a></li>`;}h+=`</ul>`;}
  h+=`</li>`;}
 h+=`</ul></nav><div class="side-foot"><button class="nt" style="width:100%;border:0;background:none;cursor:pointer" data-act="collapse" id="collapseBtn" aria-label="${esc(t(S.collapsed?'expand':'collapse'))}" data-navtip="${esc(t(S.collapsed?'expand':'collapse'))}">${ic('side')}<span class="lbl">${esc(t(S.collapsed?'expand':'collapse'))}</span></button></div></aside><div class="backdrop" id="backdrop" data-act="sidenavclose"></div>`;
 return h;}
function killBand(){const on=Object.entries(S.kill).filter(([,v])=>v.on);if(!on.length)return'';return on.map(([k,v])=>`<div class="killband" role="status">${ic('alert','sm')}<span>${esc(t('killBand',{name:t(k)}))} · ${esc(v.by)} · ${esc(rel(v.at))}</span><a href="${href('ops','incidents','INC-0042')}">${esc(t('viewIncident'))}</a></div>`).join('');}
function renderShell(){L10N.set(tag());document.documentElement.lang=tag();document.documentElement.dataset.theme=S.theme;document.documentElement.dataset.density=S.density;document.title=t('docTitle');
 $('#skipLink').textContent=t('skip');
 $('#app').innerHTML=`<div class="app ${S.collapsed?'collapsed':''}" id="appGrid">${topbar()}<div class="prototype-band">${esc(t("demo"))} · ${esc(t("demoTip"))} · ${esc(t("designed"))}</div>${killBand()}${sidebar()}<main id="main" tabindex="-1"><div class="page" id="page"></div></main></div><aside class="drawer" id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle"></aside>`;
 if(S.collapsed)$('#appGrid').style.gridTemplateRows='var(--topbar) '+(Object.values(S.kill).some(v=>v.on)?'auto ':'')+'minmax(0,1fr)';
 fixGridRows();}
function fixGridRows(){const g=$('#appGrid');if(!g)return;const bands=$$('.killband,.prototype-band',g).length;g.style.gridTemplateRows=`var(--topbar) ${'auto '.repeat(bands)}minmax(0,1fr)`;}
function screenHtml(){const {sec,item,param}=S.route;const f=SCREENS[sec+'/'+item];return f?f(param):designed(sec,item);}
function renderPage(anim){const p=$('#page');p.innerHTML=screenHtml();if(anim){p.classList.remove('enter');void p.offsetWidth;p.classList.add('enter');}mount();}
function skeleton(){return `<div aria-busy="true" aria-label="${esc(t('loading'))}"><div class="sk" style="width:180px;height:14px;margin-bottom:10px"></div><div class="sk" style="width:260px;height:28px;margin-bottom:22px"></div><div class="card"><div class="fbar"><div class="sk" style="width:240px;height:32px"></div></div>${Array.from({length:6},()=>`<div style="display:flex;gap:16px;padding:14px 16px;border-bottom:1px solid var(--border)"><div class="sk" style="flex:2;height:14px"></div><div class="sk" style="flex:1;height:14px"></div><div class="sk" style="flex:1;height:14px"></div></div>`).join('')}</div></div>`;}
function parseHash(){const h=(location.hash||'').replace(/^#\/?/,'').split('/');if(h[0]==='node')return{sec:'node',item:'console',param:null};const sec=secById(h[0])?h[0]:'home';const s=secById(sec);const item=s.items.some(i=>i[0]===h[1])?h[1]:s.items[0][0];return{sec,item,param:h[2]||null};}
let navTimer=null;
function navigate(first){const prev=S.route;S.route=parseHash();closeDrawer(true);closePop();
 if(first){renderShell();renderPage(false);return;}
 const changedSec=prev.sec!==S.route.sec;
 // re-render the sidebar only (keeps topbar focus stable)
 const side=$('#side');const wasOpen=side&&side.classList.contains('open');
 side.outerHTML=sidebar().replace(/<div class="backdrop"[^>]*><\/div>$/,'');
 if(wasOpen)closeSide();
 const p=$('#page');p.innerHTML=skeleton();clearTimeout(navTimer);
 navTimer=setTimeout(()=>{renderPage(true);const h1=$('#pageTitle');if(h1)h1.focus({preventScroll:false});window.scrollTo(0,0);},changedSec?260:160);}
window.addEventListener('hashchange',()=>navigate(false));
function rerender(){const a=document.activeElement;const id=a&&a.id;let sel=null;try{if(a&&a.selectionStart!=null)sel=[a.selectionStart,a.selectionEnd];}catch(e){}
 renderPage(false);if(id){const n=document.getElementById(id);if(n){n.focus({preventScroll:true});if(sel&&n.setSelectionRange)try{n.setSelectionRange(sel[0],sel[1]);}catch(e){}}}}
function rerenderAll(){const a=document.activeElement;const id=a&&a.id;renderShell();renderPage(false);if(id){const n=document.getElementById(id);if(n)n.focus({preventScroll:true});}}
function refreshTopbarCounts(){const w=waitingForMe().length;const b=$('#apBtn');if(!b)return;b.setAttribute('aria-label',t('approvals')+(w?' ('+fN(w)+')':''));let c=$('#apCount');if(w){if(!c){b.insertAdjacentHTML('beforeend',`<span class="dotcount" aria-hidden="true" id="apCount"></span>`);c=$('#apCount');}if(c.textContent!==fN(w)){c.textContent=fN(w);c.classList.remove('bump');void c.offsetWidth;c.classList.add('bump');}}else if(c)c.remove();
 const nh=$('#nt-home .cnt');if(nh)nh.textContent=fN(w);
 $$('[data-navcount]').forEach(el=>{const [s,i]=el.dataset.navcount.split('/');el.textContent=fN(navCount(s,i));});}

/* ================= Mount hooks: tabs indicator, chart hover ================= */
const TABPOS={};
function mount(){
 $$('.tabs').forEach(tb=>{const id=tb.dataset.tabs;const sel=$('[aria-selected="true"]',tb);const ind=$('.ind',tb);if(!sel||!ind)return;const to={x:sel.offsetLeft,w:sel.offsetWidth};const from=TABPOS[id];
  if(from){ind.style.transition='none';ind.style.transform=`translateX(${from.x}px)`;ind.style.width=from.w+'px';void ind.offsetWidth;ind.style.transition='';}
  ind.style.transform=`translateX(${to.x}px)`;ind.style.width=to.w+'px';TABPOS[id]=to;});
 $$('.chart').forEach(ch=>{const tip=$('.ctip',ch);const svg=$('svg',ch);if(!tip||!svg)return;const xh=$('.xh',svg),pt=$('.pt',svg);
  const show=el=>{const r=ch.getBoundingClientRect(),b=el.getBoundingClientRect();tip.innerHTML=`<strong>${el.dataset.tipv}</strong> · ${el.dataset.tipl}`;tip.style.left=(b.left-r.left+b.width/2)+'px';
   if(el.dataset.hx&&xh){xh.setAttribute('x1',el.dataset.hx);xh.setAttribute('x2',el.dataset.hx);xh.style.display='';pt.setAttribute('cx',el.dataset.hx);pt.setAttribute('cy',el.dataset.hy);pt.style.display='';const sc=r.width/svg.viewBox.baseVal.width;tip.style.left=(el.dataset.hx*sc)+'px';tip.style.top=(el.dataset.hy*sc)+'px';}
   else tip.style.top=(b.top-r.top)+'px';tip.classList.add('on');};
  const hide=()=>{tip.classList.remove('on');if(xh){xh.style.display='none';pt.style.display='none';}};
  $$('[data-tipv]',svg).forEach(el=>{el.addEventListener('mouseenter',()=>show(el));el.addEventListener('mouseleave',hide);});});
}

/* ================= Popovers, dialogs, drawer, toasts ================= */
let popEl=null,popBtn=null;
function openPop(btn,html){closePop();const p=document.createElement('div');p.className='pop';p.innerHTML=html;p.setAttribute('role','dialog');p.setAttribute('aria-label',btn.getAttribute('aria-label')||'');document.body.appendChild(p);
 const r=btn.getBoundingClientRect();const w=Math.max(p.offsetWidth,240);let left=Math.min(window.innerWidth-w-8,Math.max(8,r.right-w));p.style.left=left+'px';p.style.top=(r.bottom+6+window.scrollY)+'px';p.style.width=w+'px';
 btn.setAttribute('aria-expanded','true');popEl=p;popBtn=btn;const f=$('button,select,input,a',p);if(f)f.focus();}
function closePop(ret){if(!popEl)return;popEl.remove();popEl=null;if(popBtn){popBtn.setAttribute('aria-expanded','false');if(ret)popBtn.focus();}popBtn=null;}
document.addEventListener('mousedown',e=>{if(popEl&&!popEl.contains(e.target)&&e.target.closest('[aria-expanded]')!==popBtn)closePop();});
function dialog({title,body,actions,onSubmit,cls,danger}){const d=document.createElement('dialog');if(cls)d.className=cls;const tid=nid('dlg');d.setAttribute('aria-labelledby',tid);
 d.innerHTML=`<form method="dialog" novalidate><div class="dlg-h"><h2 id="${tid}">${esc(title)}</h2><button type="button" class="iconbtn" data-close aria-label="${esc(t('close'))}">${ic('x')}</button></div><div class="dlg-b">${body}</div><div class="dlg-f"><button type="button" class="btn" data-close>${esc(t('cancel'))}</button>${actions}</div></form>`;
 document.body.appendChild(d);d.addEventListener('close',()=>setTimeout(()=>d.remove(),10));$$('[data-close]',d).forEach(b=>b.addEventListener('click',()=>d.close()));
 $('form',d).addEventListener('submit',e=>{e.preventDefault();if(onSubmit(new FormData(e.target),d)!==false)d.close();});d.showModal();const f=$('input,select,textarea',d);if(f)f.focus();return d;}
function fieldErr(d,name,msg){const i=$(`[name="${name}"]`,d);const e=$(`#${i.getAttribute('aria-describedby')}`,d);if(msg){i.setAttribute('aria-invalid','true');e.textContent=msg;i.focus();}else{i.removeAttribute('aria-invalid');e.textContent='';}return !msg;}
function toast(msg,tone){const box=$('#toasts');const el=document.createElement('div');el.className='toast';el.innerHTML=`${ic(tone==='bad'?'alert':'check','sm')}<span>${esc(msg)}</span><button class="x" aria-label="${esc(t('close'))}">${ic('x','sm')}</button>`;box.appendChild(el);
 const kill=()=>{el.classList.add('out');setTimeout(()=>el.remove(),200);};$('.x',el).onclick=kill;if(tone!=='bad')setTimeout(kill,5000);}
let drawerRet=null;
function openDrawer(html,ret){const d=$('#drawer');d.innerHTML=html;drawerRet=ret||document.activeElement;requestAnimationFrame(()=>{d.classList.add('open');setTimeout(()=>{const h=$('#drawerTitle');if(h)h.focus();},60);});}
function closeDrawer(silent){const d=$('#drawer');if(!d||!d.classList.contains('open'))return;d.classList.remove('open');if(!silent&&drawerRet&&document.body.contains(drawerRet))drawerRet.focus();drawerRet=null;}
const drawerShell=(title,body,foot,lang)=>`<header><h2 id="drawerTitle" tabindex="-1" ${lang?`lang="${lang}"`:''}>${esc(title)}</h2><button class="iconbtn" data-act="drawerclose" aria-label="${esc(t('close'))}" id="drawerClose">${ic('x')}</button></header><div class="body">${body}</div>${foot?`<footer>${foot}</footer>`:''}`;
function rowDrawer(tid,id){
 if(tid==='people'||tid==='companies'){const p=personById(id);openDrawer(drawerShell(p.name,`<div class="row" style="margin-bottom:12px">${badge(p.ver)}${badge(p.status)}</div><h3 class="sh" style="margin-bottom:4px">${esc(t('pd_public'))}</h3>${kv([[t('c_type'),esc(t(p.type==='company'?'ty_company':'ty_person'))],[t('c_trade'),esc(t(p.trade))],[t('c_region'),`<span lang="en">${esc(p.county)}</span>`],[t('c_joined'),esc(fDate(p.joined))],[t('pd_confirmations'),`<span class="num">${fN(p.conf)}</span>`],[t('pd_projects'),`<span class="num">${fN(p.proj)}</span>`]])}`,`${hint(t('pd_caseTip'))}<a class="btn primary" href="${href('users','support',p.id)}">${ic('life','sm')}${esc(t('pd_openSupport'))}</a>`,'en'));}
 else if(tid==='cases'){location.hash=href('users','support',CASES.find(c=>c.id===id).pid);}
 else if(tid==='inc'){location.hash=href('ops','incidents',id);}
 else if(tid.startsWith('queue')){const c=CONTENT.find(x=>x.id===id);const canDecide=c.stage==='cq_review';
  openDrawer(drawerShell(c.title,`<div class="row" style="margin-bottom:12px">${badge(c.stage)}<span class="b outline nodot">${esc(t(c.fmt))}</span></div>${kv([[t('s_locales'),c.langs.map(l=>`<span class="b outline nodot">${l}</span>`).join(' ')],[t('c_assignee'),whoLabel(c.who)],[t('c_due'),esc(rel(c.due))],[t('s_sources'),'<span class="num">3</span>'],[t('cd_claims'),'<span class="num">7 / 7</span>']])}`,
   canDecide?`<button class="btn" data-act="cret" data-id="${c.id}" id="cRet">${esc(t('returnBtn'))}</button>`+(c.self?`<span class="hint end"><button class="btn primary" aria-disabled="true" aria-describedby="selfTip" data-act="hint" id="cApp">${esc(t('approve'))}</button><span class="tip" role="tooltip" id="selfTip">${esc(t('cd_selfTip'))}</span></span>`:`<button class="btn primary" data-act="capp" data-id="${c.id}" id="cApp">${esc(t('approve'))}</button>`):''));}
 else if(tid==='runs'){const r=S.runs.find(x=>x.id===id);const a=agentById(r.agent);const steps=[['tl_opened','info'],['ev_runStart','info']];
  openDrawer(drawerShell(r.id,`<div class="row" style="margin-bottom:12px">${badge(r.status)}<span class="b ai nodot">${ic('spark','sm')}${esc(a.name)}</span></div>${kv([[t('c_agent'),esc(a.name+' · '+t(a.role))],[t('c_task'),esc(t(a.task))],[t('c_autonomy'),esc(t(a.aut))],[t('c_accountable'),esc(a.acc)],[t('c_started'),`<span class="num">${esc(fTime(r.start))}</span>`],[t('c_duration'),`<span class="num" ${r.status==='run_running'?`data-dur="${r.start}"`:''}>${esc(fDur(((r.end||Date.now())-r.start)/1000))}</span>`],[t('c_spend'),`<span class="num">${esc(fUSD(r.cost))}</span>`]])}`,
   `<button class="btn" data-act="pausea" data-id="${a.id}" id="dPa">${ic(a.state==='st_paused'?'play':'pause','sm')}${esc(t(a.state==='st_paused'?'resume':'pause'))} · ${esc(a.name)}</button><button class="btn danger" data-act="stopa" data-id="${a.id}" id="dSa">${ic('power','sm')}${esc(t('stop'))}</button>`));}
}

/* ================= Command palette ================= */
function openPalette(){const d=document.createElement('dialog');d.className='pal';d.setAttribute('aria-label',t('ks_palette'));
 d.innerHTML=`<div class="pal-in">${ic('search')}<input role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" placeholder="${esc(t('pal_ph'))}" aria-label="${esc(t('pal_ph'))}" id="palIn" autocomplete="off"><kbd>Esc</kbd></div><ul class="pal-list" role="listbox" id="palList" aria-label="${esc(t('pal_ph'))}"></ul>`;
 document.body.appendChild(d);d.addEventListener('close',()=>setTimeout(()=>d.remove(),10));d.showModal();
 const input=$('#palIn',d),list=$('#palList',d);let items=[],ix=0;
 const all=()=>{const secs=[];NAV.forEach(s=>s.items.forEach(([id,l])=>secs.push({g:'pal_sections',label:t(s.label)+' › '+t(l),icon:s.icon,go:()=>location.hash=href(s.id,id)})));
  const cmds=[{g:'pal_commands',label:t('cmd_invite'),icon:'plus',go:()=>{location.hash=href('users','staff');setTimeout(inviteDialog,350);}},{g:'pal_commands',label:t('cmd_engage'),icon:'power',go:()=>location.hash=href('automation','kill')},{g:'pal_commands',label:t('newPrice'),icon:'dollar',go:()=>{location.hash=href('automation','models');setTimeout(priceDialog,350);}},{g:'pal_commands',label:t('cmd_theme'),icon:'moon',go:()=>{S.theme=S.theme==='dark'?'light':'dark';savePrefs();document.documentElement.dataset.theme=S.theme;}},{g:'pal_commands',label:t(S.live?'h_pauseLive':'h_resumeLive'),icon:'pause',go:()=>toggleLive()}];
  return secs.concat(cmds);};
 const draw=()=>{const q=input.value.trim().toLowerCase();const isPerson=q.length>=3&&(/@/.test(q)||PEOPLE.some(p=>p.name.toLowerCase().includes(q)));
  items=all().filter(i=>!q||i.label.toLowerCase().includes(q));
  if(isPerson&&!items.length)items=[{g:'pal_commands',label:t('pal_lookup'),icon:'life',go:()=>{S.tabs.support='lookup';location.hash=href('users','support');}}];
  ix=Math.min(ix,Math.max(0,items.length-1));let g=null,h='';
  items.slice(0,40).forEach((it,i)=>{if(it.g!==g){g=it.g;h+=`<li class="pal-g" role="presentation">${esc(t(g))}</li>`;}h+=`<li class="pal-o" role="option" id="po-${i}" aria-selected="${i===ix}" data-i="${i}">${ic(it.icon,'sm')}<span>${esc(it.label)}</span></li>`;});
  list.innerHTML=h||`<li class="pal-g" role="presentation">${esc(t('pal_none'))}</li>`;input.setAttribute('aria-activedescendant',items.length?'po-'+ix:'');const sel=$('[aria-selected="true"]',list);if(sel)sel.scrollIntoView({block:'nearest'});};
 const go=i=>{const it=items[i];if(!it)return;d.close();it.go();};
 input.addEventListener('input',()=>{ix=0;draw();});
 input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();ix=Math.min(items.length-1,ix+1);draw();}else if(e.key==='ArrowUp'){e.preventDefault();ix=Math.max(0,ix-1);draw();}else if(e.key==='Enter'){e.preventDefault();go(ix);}});
 list.addEventListener('click',e=>{const o=e.target.closest('.pal-o');if(o)go(+o.dataset.i);});
 d.addEventListener('click',e=>{if(e.target===d)d.close();});draw();input.focus();}

/* ================= Flows ================= */
function stepUp(onOk){dialog({title:t('su_title'),body:`<div class="fld"><label for="suCode">${esc(t('su_code'))}</label><input class="inp num" id="suCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-describedby="suErr suHint" style="font-size:20px;letter-spacing:.3em;height:44px"><span class="err" id="suErr"></span><span class="meta" id="suHint">${esc(t('su_hint'))}</span></div>`,actions:`<button class="btn primary" type="submit">${esc(t('confirm'))}</button>`,
 onSubmit:(fd,d)=>{if(!/^\d{6}$/.test(String(fd.get('code')).trim())){fieldErr(d,'code',t('su_err'));return false;}onOk();}});}
function decideApproval(id,ok,reason){const a=S.approvals.find(x=>x.id===id);const card=$('#ap-'+id);const done=()=>{a.status=ok?'approved':'declined';a.decided=Date.now();if(a.onApprove&&ok)a.onApprove();rerender();refreshTopbarCounts();toast(t(ok?'st_approved':'st_declined')+': '+tp(a.title));
  const next=$('.ap .btn.primary:not([aria-disabled])');if(next)next.focus();else{const h=$('#pageTitle');if(h)h.focus();}};
 if(card){card.classList.add('leaving');setTimeout(done,260);}else done();}
function addApproval(title,diff,reason,extra){const id='AP-'+(320+S.approvals.length);S.approvals.unshift(Object.assign({id,title,by:ME,at:Date.now(),exp:Date.now()+48*H,reason,diff,status:'pending'},extra||{}));return id;}
function inviteDialog(){dialog({title:t('cmd_invite'),body:`<div class="fld"><label for="ivE">${esc(t('k_email'))}</label><input class="inp" id="ivE" name="e" type="email" autocomplete="off" aria-describedby="ivEErr"><span class="err" id="ivEErr"></span></div><div class="fld"><label for="ivR">${esc(t('c_role'))}</label><select class="inp" id="ivR" name="r">${MATRIX.roles.concat('r_editor').map(r=>`<option value="${r}">${esc(t(r))}</option>`).join('')}</select></div><div class="fld"><label for="ivW">${esc(t('reason'))}</label><input class="inp" id="ivW" name="w" aria-describedby="ivWErr"><span class="err" id="ivWErr"></span></div>`,
 actions:`<button class="btn primary" type="submit">${esc(t('requestApproval'))}</button>`,onSubmit:(fd,d)=>{const okE=fieldErr(d,'e',/^\S+@\S+\.\S+$/.test(fd.get('e'))?null:t('k_email'));if(!okE)return false;if(!fieldErr(d,'w',String(fd.get('w')).trim()?null:t('reasonReq')))return false;
  addApproval(['ap_role',{name:String(fd.get('e'))}],[['c_role','—','@'+fd.get('r')]],String(fd.get('w')));toast(t('toast_requested'));refreshTopbarCounts();}});}
function priceDialog(){dialog({title:t('newPrice'),body:`<div class="fld"><label for="npC">${esc(t('c_capability'))}</label><select class="inp" id="npC" name="c">${PRICES.map(p=>`<option value="${p.id}">${esc(t(p.cap))} · ${esc(fUSD(p.price))}</option>`).join('')}</select></div><div class="grid g2"><div class="fld"><label for="npP">${esc(t('np_new'))}</label><input class="inp num" id="npP" name="p" inputmode="decimal" aria-describedby="npPErr"><span class="err" id="npPErr"></span></div><div class="fld"><label for="npD">${esc(t('f_effective'))}</label><input class="inp" id="npD" name="d" type="date" value="2026-12-01"></div></div><div class="fld"><label for="npR">${esc(t('reason'))}</label><input class="inp" id="npR" name="r" aria-describedby="npRErr"><span class="err" id="npRErr"></span></div><div class="row meta">${ic('lock','sm')} ${esc(t('lk_neutralTip'))}</div>`,
 actions:`<button class="btn primary" type="submit">${esc(t('requestApproval'))}</button>`,onSubmit:(fd,d)=>{const v=parseFloat(String(fd.get('p')).replace(',','.'));if(!fieldErr(d,'p',v>0?null:t('np_new')))return false;if(!fieldErr(d,'r',String(fd.get('r')).trim()?null:t('reasonReq')))return false;
  const p=PRICES.find(x=>x.id===fd.get('c'));p.pending=true;addApproval(['ap_price',{v:p.v+1,cap:'@'+p.cap}],[['f_price',()=>fUSD(p.price),()=>fUSD(v)],['f_effective','—',String(fd.get('d'))]],String(fd.get('r')));toast(t('toast_requested'));rerender();refreshTopbarCounts();}});}
function engageDialog(k){const word=HUB_SLUG;dialog({title:t('inc_engageTitle',{name:t(k)}),body:`<p style="margin:0">${esc(t('inc_engageBody'))}</p><div class="fld"><label for="egR">${esc(t('reason'))}</label><input class="inp" id="egR" name="r" aria-describedby="egRErr"><span class="err" id="egRErr"></span></div><div class="fld"><label for="egW">${esc(t('typeToConfirm',{word}))}</label><input class="inp" id="egW" name="w" autocomplete="off" spellcheck="false" aria-describedby="egWErr" style="font-family:var(--font-mono)"><span class="err" id="egWErr"></span></div>`,
 actions:`<button class="btn danger" type="submit">${ic('power','sm')}${esc(t('engage'))}</button>`,onSubmit:(fd,d)=>{if(!fieldErr(d,'r',String(fd.get('r')).trim()?null:t('reasonReq')))return false;if(!fieldErr(d,'w',String(fd.get('w')).trim()===word?null:t('typeMismatch',{word})))return false;
  S.kill[k]={on:true,by:ME,at:Date.now(),rel:false};S.incTimeline.push({at:Date.now(),k:'tl_engaged',cls:'bad',who:ME,note:t(k)});if(k==='ks_dispatch')runningRuns().forEach(r=>{r.status='run_stopped';r.end=Date.now();});
  const f=document.activeElement&&document.activeElement.id;renderShell();renderPage(false);toast(t('killBand',{name:t(k)}),'bad');$('#alerter').textContent=t('killBand',{name:t(k)});}});}
function releaseDialog(k){dialog({title:t('reqRelease')+': '+t(k),body:`<div class="fld"><label for="rlN">${esc(t('releaseNote'))}</label><textarea class="inp" id="rlN" name="n" rows="3" style="height:auto;padding:8px 10px" aria-describedby="rlNErr"></textarea><span class="err" id="rlNErr"></span></div><div class="row meta">${ic('users','sm')} ${esc(t('set_secondTip'))}</div>`,
 actions:`<button class="btn primary" type="submit">${esc(t('requestApproval'))}</button>`,onSubmit:(fd,d)=>{const n=String(fd.get('n')).trim();if(!fieldErr(d,'n',n?null:t('reasonReq')))return false;S.kill[k].rel=true;S.incTimeline.push({at:Date.now(),k:'tl_releaseReq',cls:'warn',who:ME,note:n});addApproval(['ap_release',{what:'@'+k}],[['f_state','@engaged','@released']],n);toast(t('toast_requested'));rerender();refreshTopbarCounts();}});}
function stopAgentDialog(id){const a=agentById(id);dialog({title:t('stopTitle',{name:a.name}),body:`<p style="margin:0">${esc(t('stopBody'))}</p><div class="fld"><label for="saR">${esc(t('reason'))}</label><input class="inp" id="saR" name="r" aria-describedby="saRErr"><span class="err" id="saRErr"></span></div>`,actions:`<button class="btn danger" type="submit">${ic('power','sm')}${esc(t('stop'))}</button>`,
 onSubmit:(fd,d)=>{if(!fieldErr(d,'r',String(fd.get('r')).trim()?null:t('reasonReq')))return false;a.state='st_stopped';S.runs.filter(r=>r.agent===id&&r.status==='run_running').forEach(r=>{r.status='run_stopped';r.end=Date.now();});closeDrawer();toast(t('toast_stopped',{name:a.name}),'bad');rerender();}});}
function toggleLive(){S.live=!S.live;rerender();announce(t(S.live?'h_live':'h_paused'));}
function shortcutsDialog(){const k=(keys,l)=>`<tr><td style="padding:6px 0">${esc(t(l))}</td><td style="text-align:right">${keys}</td></tr>`;dialog({title:t('shortcuts'),body:`<table style="width:100%;border-collapse:collapse">${k(`<kbd>${MODK}</kbd> <kbd>K</kbd>`,'ks_palette')}${k('<kbd>/</kbd>','ks_filter')}${k(`<kbd>g</kbd> ${esc(t('ks_then'))} <kbd>h</kbd>`,'ks_goHome')}${k(`<kbd>g</kbd> ${esc(t('ks_then'))} <kbd>a</kbd>`,'ks_goInbox')}${k(`<kbd>g</kbd> ${esc(t('ks_then'))} <kbd>r</kbd>`,'ks_goRuns')}${k('<kbd>j</kbd> <kbd>k</kbd>','ks_rows')}${k('<kbd>?</kbd>','ks_help')}${k('<kbd>Esc</kbd>','ks_close')}</table><label class="switch"><input type="checkbox" role="switch" data-in="singlekey" ${S.singleKey?'checked':''}><span class="tr"></span><span>${esc(t('singleKey'))}</span></label>`,actions:'',onSubmit:()=>true});}
