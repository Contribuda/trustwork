/* ================= Actions (event delegation) ================= */
const ACT={
 hint(el){const h=el.closest('.hint');const open=h.classList.toggle('open');if(open){$$('.hint.open').forEach(x=>x!==h&&x.classList.remove('open'));}},
 tab(el){S.tabs[el.dataset.tabs]=el.dataset.v;rerender();const n=$(`#tab-${el.dataset.tabs}-${el.dataset.v}`);if(n)n.focus();},
 sort(el){const st=TS(el.dataset.t);if(st.sort.key===el.dataset.k)st.sort.dir*=-1;else st.sort={key:el.dataset.k,dir:1};rerender();},
 view(el){const st=TS(el.dataset.t);st.view=el.dataset.v||null;st.page=0;st.sel.clear();rerender();},
 fclear(el){const st=TS(el.dataset.t);delete st.f[el.dataset.k];st.page=0;rerender();const n=$(`#f-${el.dataset.t}-${el.dataset.k}`);if(n)n.focus();},
 fclearall(el){const st=TS(el.dataset.t);st.f={};st.q='';st.page=0;rerender();const n=$(`#q-${el.dataset.t}`);if(n)n.focus();},
 page(el){const st=TS(el.dataset.t);st.page+=+el.dataset.d;rerender();},
 sel(el,e){e.stopPropagation();const st=TS(el.dataset.t);el.checked?st.sel.add(el.dataset.id):st.sel.delete(el.dataset.id);rerender();announce(t('selected',{n:fN(st.sel.size)}));},
 selall(el){const st=TS(el.dataset.t);const ids=$$(`#dt-${el.dataset.t} tbody .cb`).map(c=>c.dataset.id);ids.forEach(id=>el.checked?st.sel.add(id):st.sel.delete(id));rerender();announce(t('selected',{n:fN(st.sel.size)}));},
 selnone(el){TS(el.dataset.t).sel.clear();rerender();},
 bulk(el){const st=TS(el.dataset.t);toast(t(el.dataset.b==='export'?'toast_exported':'toast_sentReview')+' · '+t('selected',{n:fN(st.sel.size)}));st.sel.clear();rerender();},
 row(el,e){if(e.target.closest('input,a')&&e.target.closest('input,a')!==el)return;rowDrawer(el.dataset.t,el.dataset.id);},
 colmenu(el){const st=TS(el.dataset.t);const cols=(TABLE_COLS[el.dataset.t]||[]);openPop(el,`<div class="lab">${esc(t('columns'))}</div>${cols.map(c=>`<label class="mi"><input type="checkbox" class="cb" data-in="col" data-t="${el.dataset.t}" data-k="${c.key}" ${st.hidden.has(c.key)?'':'checked'}>${esc(t(c.label))}</label>`).join('')}`);},
 toast(el){toast(t(el.dataset.m));},
 live(){toggleLive();},
 approve(el){const id=el.dataset.id;stepUp(()=>decideApproval(id,true));},
 decline(el){const id=el.dataset.id;dialog({title:t('dl_title'),body:`<div class="fld"><label for="dlR">${esc(t('reason'))}</label><input class="inp" id="dlR" name="r" aria-describedby="dlRErr"><span class="err" id="dlRErr"></span></div>`,actions:`<button class="btn danger" type="submit">${esc(t('decline'))}</button>`,onSubmit:(fd,d)=>{if(!fieldErr(d,'r',String(fd.get('r')).trim()?null:t('reasonReq')))return false;decideApproval(id,false);}});},
 withdraw(el){const a=S.approvals.find(x=>x.id===el.dataset.id);a.status='withdrawn';a.decided=Date.now();if(S.grant&&S.grant.ap===a.id)S.grant=null;if(S.modesPending&&S.modesPending.ap===a.id)S.modesPending=null;toast(t('st_withdrawn')+': '+tp(a.title));rerender();refreshTopbarCounts();},
 invite(){inviteDialog();},
 newprice(){priceDialog();},
 engage(el){engageDialog(el.dataset.k);},
 release(el){releaseDialog(el.dataset.k);},
 pausea(el){const a=agentById(el.dataset.id);a.state=a.state==='st_paused'?'st_active':'st_paused';toast(t(a.state==='st_paused'?'toast_paused':'toast_resumed',{name:a.name}));closeDrawer(true);rerender();},
 stopa(el){stopAgentDialog(el.dataset.id);},
 restart(el){const a=agentById(el.dataset.id);addApproval(['ap_restart',{what:a.name}],[['f_state','@st_stopped','@st_active']],'—');toast(t('toast_requested'));refreshTopbarCounts();},
 discard(){S.draft=null;rerender();},
 reviewmodes(){const diff=Object.keys(S.modes).filter(k=>S.draft[k]!==S.modes[k]).map(k=>[MODE_LABEL[k],modeVal(k,S.modes[k]),modeVal(k,S.draft[k])]);
  dialog({title:t('reviewChanges'),body:`${diffTable(diff)}<div class="fld"><label for="mdR">${esc(t('reason'))}</label><input class="inp" id="mdR" name="r" aria-describedby="mdRErr"><span class="err" id="mdRErr"></span></div><div class="row meta">${ic('users','sm')} ${esc(t('set_secondTip'))}</div>`,actions:`<button class="btn primary" type="submit">${esc(t('requestApproval'))}</button>`,
   onSubmit:(fd,d)=>{if(!fieldErr(d,'r',String(fd.get('r')).trim()?null:t('reasonReq')))return false;const v=MODE_VERSIONS[0].v+1;const draft=S.draft;const ap=addApproval(['ap_settings',{what:'@s_modes'}],diff,String(fd.get('r')),{onApprove:()=>{S.modes=draft;}});S.modesPending={v,ap};S.draft=null;toast(t('toast_requested'));rerender();refreshTopbarCounts();}});},
 capp(el){const c=CONTENT.find(x=>x.id===el.dataset.id);stepUp(()=>{c.stage='sg_scheduled';closeDrawer();toast(t('st_approved')+': '+c.title);rerender();});},
 cret(el){const c=CONTENT.find(x=>x.id===el.dataset.id);c.stage='sg_returned';closeDrawer();toast(t('sg_returned')+': '+c.title);rerender();},
 chmode(el){S.tabs['ch-'+el.dataset.c]=el.dataset.v;rerender();},
 drawerclose(){closeDrawer();},
 palette(){openPalette();},
 shortcuts(){shortcutsDialog();},
 collapse(){S.collapsed=!S.collapsed;savePrefs();$('#appGrid').classList.toggle('collapsed',S.collapsed);const b=$('#collapseBtn');b.setAttribute('aria-label',t(S.collapsed?'expand':'collapse'));b.dataset.navtip=t(S.collapsed?'expand':'collapse');$('.lbl',b).textContent=t(S.collapsed?'expand':'collapse');setTimeout(mount,260);},
 sidenav(){const s=$('#side');s.classList.add('open');$('#backdrop').classList.add('open');$('#menuBtn').setAttribute('aria-expanded','true');const f=$('a,button',s);if(f)f.focus();},
 sidenavclose(){closeSide(true);},
 notif(el){if(popEl&&popBtn===el){closePop();return;}openPop(el,`<div class="lab">${esc(t('notifications'))}</div>${S.notifications.length?S.notifications.map(n=>`<a class="mi" href="${href('home','approvals')}" style="height:auto;padding:8px 10px;align-items:flex-start;text-decoration:none">${n.read?'':'<span class="b info nodot" style="height:8px;width:8px;padding:0;border-radius:50%;margin-top:6px"></span>'}<span style="flex:1"><span style="display:block">${esc(tp(n.title))}</span><span class="meta">${esc(t(n.state))} · ${esc(rel(n.at))}</span></span></a>`).join(''):`<p class="meta" style="padding:8px 10px">${esc(t('nt_empty'))}</p>`}<hr><button class="mi" data-act="markread" id="ntMark">${ic('check','sm')}${esc(t('nt_markRead'))}</button>`);},
 markread(){S.notifications.forEach(n=>n.read=true);closePop();rerenderAll();$('#ntBtn').focus();},
 user(el){if(popEl&&popBtn===el){closePop();return;}openPop(el,`<div style="padding:6px 10px 8px"><div style="font-weight:600">${esc(ME)}</div><div class="meta">${esc(t('r_owner'))}</div></div><hr>
  <div class="lab">${esc(t('theme'))}</div><div style="padding:4px 10px"><div class="seg" role="radiogroup" aria-label="${esc(t('theme'))}">${[['light','sun'],['dark','moon'],['system','side']].map(([v,i])=>`<label><input type="radio" name="th" value="${v}" data-in="theme" ${S.theme===v?'checked':''}>${ic(i,'sm')}${esc(t(v))}</label>`).join('')}</div></div>
  <div class="lab">${esc(t('density'))}</div><div style="padding:4px 10px"><div class="seg" role="radiogroup" aria-label="${esc(t('density'))}">${['comfortable','compact'].map(v=>`<label><input type="radio" name="dn" value="${v}" data-in="density" ${S.density===v?'checked':''}>${esc(t(v))}</label>`).join('')}</div></div>
  <div class="lab">${esc(t('language'))}</div><div style="padding:4px 10px"><select class="inp" style="width:100%" data-in="lang" aria-label="${esc(t('language'))}">${langOptions()}</select></div><hr>
  <button class="mi" data-act="shortcuts">${ic('kbd','sm')}${esc(t('shortcuts'))}</button><a class="mi" href="#/home/overview" style="text-decoration:none">${ic('back','sm')}${esc(t('backToApp'))}</a><button class="mi" data-act="toast" data-m="signOut">${ic('logout','sm')}${esc(t('signOut'))}</button>`);}
};
function closeSide(ret){const s=$('#side');if(!s)return;s.classList.remove('open');const b=$('#backdrop');if(b)b.classList.remove('open');const m=$('#menuBtn');if(m){m.setAttribute('aria-expanded','false');if(ret)m.focus();}}
const TABLE_COLS={};
const _dt=dataTable;dataTable=function(o){TABLE_COLS[o.id]=o.cols.filter(c=>c.hide);return _dt(o);};
const IN={
 q(el){const st=TS(el.dataset.t);st.q=el.value;st.page=0;rerender();},
 filter(el){const st=TS(el.dataset.t);if(el.value)st.f[el.dataset.k]=el.value;st.page=0;rerender();const chip=$(`#dt-${el.dataset.t} .chip button[data-k="${el.dataset.k}"]`);if(chip)chip.focus();},
 col(el){const st=TS(el.dataset.t);el.checked?st.hidden.delete(el.dataset.k):st.hidden.add(el.dataset.k);const keep=popEl;rerender();},
 lang(el){li=+el.value;savePrefs();closePop();rerenderAll();const n=innerWidth<768?$('#userBtn'):$('#langTop');if(n)n.focus();announce(LANGS[li][1]);},
 theme(el){S.theme=el.value;savePrefs();document.documentElement.dataset.theme=S.theme;},
 density(el){S.density=el.value;savePrefs();document.documentElement.dataset.density=S.density;setTimeout(mount,50);},
 singlekey(el){S.singleKey=el.checked;savePrefs();},
 mode(el){S.draft=S.draft||{...S.modes};S.draft[el.dataset.k]=el.type==='checkbox'?el.checked:el.value;if(Object.keys(S.modes).every(k=>S.draft[k]===S.modes[k]))S.draft=null;const id=el.id||(el.id=nid('in'));rerender();const n=$(`[data-k="${el.dataset.k}"]${el.type==='radio'?`[value="${el.value}"]`:''}`);if(n)n.focus();},
 period(el){S.period=el.value;rerender();}
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el)return;if(el.matches('a[href]')&&!el.dataset.act.startsWith('side'))return;const f=ACT[el.dataset.act];if(!f)return;if(el.tagName==='BUTTON'||el.tagName==='TR'||el.dataset.act==='sidenavclose')e.preventDefault&&el.tagName!=='INPUT'&&e.preventDefault();if(el.getAttribute('aria-disabled')==='true'&&el.dataset.act!=='hint')return;f(el,e);});
document.addEventListener('change',e=>{const el=e.target.closest('[data-in]');if(!el||el.dataset.in==='q')return;const f=IN[el.dataset.in];if(f)f(el,e);});
document.addEventListener('input',e=>{const el=e.target.closest('[data-in="q"]');if(el)IN.q(el);});
document.addEventListener('submit',e=>{const f=e.target.closest('[data-form]');if(!f)return;e.preventDefault();const fd=new FormData(f);
 if(f.dataset.form==='lookup'){const c=fd.get('c');S.lookup={q:String(fd.get('q')||''),c,err:!c,found:!!c};rerender();if(!c)$('#lkc').focus();else announce(t('lk_logged',{c}));}
 if(f.dataset.form==='access'){const c=fd.get('c'),s=fd.getAll('s'),r=String(fd.get('r')||'').trim();S.raErr={c:!c,s:!s.length,r:!r};if(!c||!s.length||!r){rerender();const first=!c?'#raC':!s.length?'[name="s"]':'#raR';$(first).focus();return;}
  S.raErr=null;const p=personById(f.dataset.pid);const h=+fd.get('d');const ap=addApproval(['ap_access',{name:p.name}],[['ra_scope','—',()=>s.map(x=>t(x)).join(', ')],['ra_duration','—',()=>unit(h,'hour')]],c+': '+r);S.grant={pid:p.id,c,scopes:s,h,ap};toast(t('toast_requested'));rerender();refreshTopbarCounts();}});
document.addEventListener('mouseover',e=>{const a=e.target.closest('.collapsed .nt');let tip=$('.navtip');if(!a||window.innerWidth<768){if(tip)tip.remove();return;}if(!tip){tip=document.createElement('div');tip.className='navtip';tip.setAttribute('aria-hidden','true');document.body.appendChild(tip);}const r=a.getBoundingClientRect();tip.textContent=a.dataset.navtip;tip.style.left=(r.right+8)+'px';tip.style.top=(r.top+r.height/2-13)+'px';});

/* ================= Keyboard ================= */
let gPending=false,gTimer=null;
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){if(popEl){closePop(true);return;}const ho=$('.hint.open');if(ho){ho.classList.remove('open');return;}if(document.activeElement&&document.activeElement.closest('.hint')){document.activeElement.blur();return;}if($('#drawer.open')&&!$('dialog[open]')){closeDrawer();return;}if($('#side.open')){closeSide(true);return;}}
 if(e.target.getAttribute&&e.target.getAttribute('role')==='tab'&&(e.key==='ArrowRight'||e.key==='ArrowLeft')){const tabs=$$('[role="tab"]',e.target.parentElement);const i=tabs.indexOf(e.target);const n=tabs[(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];e.preventDefault();ACT.tab(n);return;}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(!$('dialog[open]'))openPalette();return;}
 const typing=e.target.closest&&e.target.closest('input,textarea,select,[contenteditable]');if(typing||e.metaKey||e.ctrlKey||e.altKey||!S.singleKey||$('dialog[open]'))return;
 if(gPending){gPending=false;clearTimeout(gTimer);const m={h:href('home','overview'),a:href('home','approvals'),r:href('automation','runs')}[e.key];if(m){e.preventDefault();location.hash=m;}return;}
 if(e.key==='g'){gPending=true;gTimer=setTimeout(()=>gPending=false,1200);return;}
 if(e.key==='/'){const f=$('[data-filter]');if(f){e.preventDefault();f.focus();}return;}
 if(e.key==='?'){e.preventDefault();shortcutsDialog();return;}
 if(e.key==='j'||e.key==='k'){const rows=$$('#page .rowbtn');if(!rows.length)return;e.preventDefault();const i=rows.indexOf(document.activeElement);const n=e.key==='j'?Math.min(rows.length-1,i+1):Math.max(0,i<0?0:i-1);rows[n].focus();rows[n].scrollIntoView({block:'nearest'});}
});

/* ================= Live engine (synthetic events) ================= */
let runSeq=4811,arrivals=0;
function pushFeed(k,v,cls,icon){S.feed.unshift({k,v,cls,icon,at:Date.now(),id:nid('f')});S.feed.length=Math.min(S.feed.length,40);}
function tick(){if(!S.live||document.hidden)return;const now=Date.now();
 // finish runs
 runningRuns().forEach(r=>{const a=agentById(r.agent);if(now-r.start>r.dur*1000){const x=R();r.end=now;r.status=x<.76?'run_ok':x<.9?'run_review':x<.97?'run_fail':'run_unknown';
  if(r.status==='run_ok')S.okToday++;else if(r.status==='run_review')S.reviewToday++;else S.failToday++;
  pushFeed(r.status==='run_ok'?'ev_runOk':r.status==='run_review'?'ev_runReview':'ev_runFail',{agent:a.name,task:'@'+a.task},r.status==='run_ok'?'ok':r.status==='run_review'?'ai':'bad','spark');}});
 // start runs
 if(!S.kill.ks_dispatch.on&&R()<.55){const pool=AGENTS.filter(a=>a.state==='st_active'&&a.spent<a.cap);if(pool.length){const a=pool[Math.floor(R()*pool.length)];const cost=+(0.02+R()*.4).toFixed(2);a.spent=+(a.spent+cost).toFixed(2);S.spend=+(S.spend+cost).toFixed(2);
  const r={id:'R-'+(runSeq++),agent:a.id,start:now,end:null,status:'run_running',cost,dur:12+Math.round(R()*40),_new:true};S.runs.unshift(r);S.runs.length=Math.min(S.runs.length,60);S.perMin[S.perMin.length-1]++;pushFeed('ev_runStart',{agent:a.name,task:'@'+a.task},'info','spark');}}
 if(R()<.12){const amt=Math.round(250+R()*4000);S.payments+=amt;pushFeed('ev_payment',{amount:fUSD(amt,0)},'neu','dollar');}
 if(R()<.05){S.cases++;pushFeed('ev_case',{id:'C-'+(1046+S.cases-12)},'info','life');}
 if(arrivals<2&&R()<.07){arrivals++;const id='AP-'+(330+arrivals);const ap={id,title:arrivals===1?['ap_price',{v:3,cap:'@cap_plan'}]:['ap_role',{name:'Synthetic Support D'}],by:arrivals===1?'Synthetic Commercial B':'Synthetic Support C',at:now,exp:now+48*H,get reason(){return t(arrivals===1?'fx_reason6':'fx_reason7')},diff:arrivals===1?[['f_price',()=>fUSD(2.50),()=>fUSD(2.75)]]:[['c_role','@r_supAgent','@r_supLead'],['c_ends','—','2026-11-30']],status:'pending'};
  S.approvals.splice(0,0,ap);pushFeed('ev_approval',{title:id},'warn','approve');announce(t('h_newApproval'));refreshTopbarCounts();}
 liveRefresh();}
setInterval(tick,3000);
setInterval(()=>{if(!S.live)return;S.perMin.shift();S.perMin.push(0);const el=$('#rpm');if(el){el.innerHTML=sparkBars(S.perMin);mount();}},60000);
setInterval(()=>{$$('[data-dur]').forEach(el=>{el.textContent=fDur((Date.now()-(+el.dataset.dur))/1000);});$$('[data-rel]').forEach(el=>{el.textContent=rel(+el.dataset.rel);});},1000);
function setLive(key,val){const el=$(`[data-live="${key}"]`);if(el&&el.innerHTML!==val){el.innerHTML=val;el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}}
function liveRefresh(){const r=S.route.sec+'/'+S.route.item;refreshTopbarCounts();
 if(r==='home/overview'&&!S.route.param){setLive('waiting',fN(waitingForMe().length));setLive('running',fN(runningRuns().length));setLive('cases',fN(S.cases));setLive('spend',fUSD(S.spend));setLive('payments',fUSD(S.payments,0));
  const sub=$('[data-live="spend-sub"] .meter span');if(sub)sub.style.width=Math.min(100,S.spend/S.spendCap*100)+'%';
  const feed=$('#feed');if(feed){const have=new Set($$('li',feed).map(l=>l.dataset.id));const fresh=S.feed.slice(0,7).filter(f=>!have.has(f.id));fresh.reverse().forEach(f=>feed.insertAdjacentHTML('afterbegin',feedItem(f)));while(feed.children.length>7)feed.lastElementChild.remove();}
  const rpm=$('#rpm');if(rpm){rpm.innerHTML=sparkBars(S.perMin);mount();}}
 if(r==='automation/runs'){setLive('r-running',fN(runningRuns().length));setLive('r-ok',fN(S.okToday));setLive('r-review',fN(S.reviewToday));setLive('r-fail',fN(S.failToday));
  const box=$('#runsTable');if(box&&!box.contains(document.activeElement)||box&&document.activeElement&&document.activeElement.id&&box.contains(document.activeElement)){const id=document.activeElement&&document.activeElement.id;box.innerHTML=runsTable();if(id&&box.querySelector('#'+CSS.escape(id)))document.getElementById(id).focus({preventScroll:true});}}
 if(r==='automation/team'){const box=$('#teamTable');if(box&&!box.contains(document.activeElement)){box.innerHTML=SCREENS['automation/team']().split('<div id="teamTable">')[1].replace(/<\/div>$/,'');}}
}

/* ================= Init ================= */
if(!location.hash)history.replaceState(null,'','#/home/overview');
navigate(true);
</script>
</body>
</html>
