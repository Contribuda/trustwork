/* ================= Screens ================= */
const SCREENS={};
const peopleCols=tid=>[
 {key:'name',label:'c_name',cls:'pr',sv:r=>r.name,r:r=>`<div>${rowBtn(tid,r.id,r.name,'en')}<div class="sec">${esc(t(r.trade))}</div></div>`},
 {key:'type',label:'c_type',sv:r=>r.type,hide:true,r:r=>esc(t(r.type==='company'?'ty_company':'ty_person'))},
 {key:'county',label:'c_region',sv:r=>r.county,hide:true,r:r=>`<span lang="en">${esc(r.county)}</span>`},
 {key:'ver',label:'s_verification',sv:r=>r.ver,r:r=>badge(r.ver)},
 {key:'joined',label:'c_joined',sv:r=>r.joined,hide:true,r:r=>`<span class="num">${esc(fDate(r.joined))}</span>`},
 {key:'status',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)}];
function peopleTable(tid,rows,type){return dataTable({id:tid,rows,cols:peopleCols(tid),select:true,row:true,pageSize:10,name:r=>r.name,text:r=>r.name+' '+t(r.trade)+' '+r.county,
 views:[['unv','v_unverified',r=>r.ver==='v_unverified'||r.ver==='v_sourced'],['res','st_restricted',r=>r.status==='st_restricted']],
 filters:[...(type?[]:[{key:'type',label:'c_type',get:r=>r.type,opts:[['person','@ty_person'],['company','@ty_company']]}]),{key:'ver',label:'s_verification',get:r=>r.ver,opts:(type==='company'?['v_sourced','v_claimed','v_verified']:['v_verified','v_unverified']).map(v=>[v,'@'+v])},{key:'county',label:'c_region',get:r=>r.county,opts:COUNTIES.map(c=>[c,c])}],
 bulk:[['export','export','download'],['review','b_review','flag']]});}
SCREENS['users/people']=()=>pageHead({title:t('s_people'),acts:`<button class="btn" data-act="toast" data-m="toast_exported" id="pplExport">${ic('download','sm')}${esc(t('export'))}</button>`})+peopleTable('people',PEOPLE.filter(p=>p.type==='person'));
SCREENS['users/companies']=()=>pageHead({title:t('s_companies'),acts:`<button class="btn" data-act="toast" data-m="toast_exported" id="coExport">${ic('download','sm')}${esc(t('export'))}</button>`})+peopleTable('companies',PEOPLE.filter(p=>p.type==='company'),'company');

/* ---------- Home: live overview ---------- */
SCREENS['home/overview']=()=>{
 const w=waitingForMe().length,run=runningRuns().length;
 const kp=(id,label,val,sub,link,extra)=>`<a class="card kpi" href="${link}" id="kpi-${id}"><span class="k">${esc(label)}${extra||''}</span><span class="v" data-live="${id}">${val}</span><span class="d" data-live="${id}-sub">${sub||'&nbsp;'}</span></a>`;
 const needs=[...waitingForMe().map(a=>({t:tp(a.title),type:'t_approval',tone:'warn',at:a.at,due:a.exp,link:href('home','approvals')})),
  {t:'C-1045 · '+t('fx_case4'),type:'t_case',tone:'info',at:NOW-50*M,due:NOW+7*H,link:href('users','support','p0'),lang:'en'},
  {t:t('fx_unlabelledAd'),type:'t_report',tone:'bad',at:NOW-2*H,due:NOW+22*H,link:href('trust','moderation'),lang:'en'},
  {t:'Testcase Concrete Inc.',type:'t_claim',tone:'neu',at:NOW-7*H,due:NOW+2*D,link:href('trust','verification'),lang:'en'}].slice(0,6);
 let h=pageHead({title:t('s_overview'),acts:`<span class="livedot ${S.live?'':'off'}" id="liveState">${esc(t(S.live?'h_live':'h_paused'))}</span><button class="btn sm" data-act="live" id="liveBtn" aria-pressed="${!S.live}">${ic(S.live?'pause':'play','sm')}${esc(t(S.live?'h_pauseLive':'h_resumeLive'))}</button>`});
 h+=`<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:var(--s4)">`+
  kp('waiting',t('h_waiting'),fN(w),'',href('home','approvals'))+
  kp('cases',t('h_cases'),fN(S.cases),'',href('users','support'))+
  kp('running',t('h_running'),fN(run),`<span class="b info run nodot" style="height:18px">${esc(t('run_running'))}</span>`,href('automation','runs'))+
  kp('spend',t('h_spend'),fUSD(S.spend),`${meter(S.spend,S.spendCap)}<span style="white-space:nowrap">${esc(t('h_ofCap',{cap:fUSD(S.spendCap,0)}))}</span>`,href('automation','team'))+
  kp('payments',t('h_payments'),fUSD(S.payments,0),'',href('commerce','payouts'),hint(t('h_paymentsTip')))+
  kp('incidents',t('h_incidents'),fN(1),badge('inc_investigating'),href('ops','incidents','INC-0042'))+`</div>`;
 h+=`<div class="grid g21" style="margin-bottom:var(--s4)"><section class="card" aria-labelledby="needsH"><div class="card-h"><h2 class="sh" id="needsH">${esc(t('h_needs'))}</h2><div class="acts"><a href="${href('home','approvals')}" class="meta">${esc(t('h_viewAll'))}</a></div></div>
 <div class="tblwrap"><table class="dt" aria-labelledby="needsH"><thead><tr><th scope="col">${esc(t('c_item'))}</th><th scope="col">${esc(t('c_type'))}</th><th scope="col">${esc(t('c_waiting'))}</th><th scope="col">${esc(t('c_due'))}</th></tr></thead><tbody id="needsBody">${needs.map((n,i)=>`<tr><td class="pr"><a href="${n.link}" class="pri" style="color:var(--text)" ${n.lang?`lang="${n.lang}"`:''}>${esc(n.t)}</a></td><td data-label="${esc(t('c_type'))}"><span class="b ${n.tone}">${esc(t(n.type))}</span></td><td data-label="${esc(t('c_waiting'))}" class="num">${esc(rel(n.at))}</td><td data-label="${esc(t('c_due'))}" class="num">${esc(rel(n.due))}</td></tr>`).join('')}</tbody></table></div></section>
 <section class="card" aria-labelledby="actH"><div class="card-h"><h2 class="sh" id="actH">${esc(t('h_activity'))}</h2><div class="acts"><span class="livedot ${S.live?'':'off'}"><span class="vh">${esc(t(S.live?'h_live':'h_paused'))}</span></span></div></div><ul class="list feed" role="log" aria-live="off" aria-labelledby="actH" id="feed">${S.feed.slice(0,7).map(feedItem).join('')}</ul></section></div>`;
 h+=`<div class="grid g3"><section class="card" aria-labelledby="rpmH"><div class="card-h"><h2 class="sh" id="rpmH">${esc(t('h_runsChart'))}</h2><span class="meta" style="margin-left:auto">${esc(t('h_last30m'))}</span></div><div class="card-b"><div class="chart spark" id="rpm">${sparkBars(S.perMin)}</div></div></section>
 <section class="card" aria-labelledby="qH"><div class="card-h"><h2 class="sh" id="qH">${esc(t('h_queues'))}</h2></div><ul class="list">${[['q_claims',3,href('trust','verification')],['q_reports',7,href('trust','moderation')],['q_review',CONTENT.filter(c=>c.stage==='cq_review').length,href('content','queue')],['q_privacy',1,href('trust','privacy')],['q_unknown',1,href('automation','runs'),hint(t('q_unknownTip'))]].map(([k,n,l,x])=>`<li><a class="t pri" href="${l}" style="color:var(--text)">${esc(t(k))}</a>${x||''}<span class="num" style="font-weight:600">${fN(n)}</span></li>`).join('')}</ul></section>
 <section class="card" aria-labelledby="hH"><div class="card-h"><h2 class="sh" id="hH">${esc(t('s_health'))}</h2></div><ul class="list">${[['hl_api','st_healthy',L10N.num(42)+' '+t('fx_millisecond')],['hl_worker','st_healthy',unit(1.2,'second')],['hl_mail','st_degraded',unit(9,'minute')],['hl_backups','st_healthy',rel(NOW-5*H)],['hl_search','st_healthy','']].map(([k,s,m])=>`<li><span class="t">${esc(t(k))}</span><span class="time">${esc(m)}</span>${badge(s)}</li>`).join('')}<li><span class="t"><a href="${href('settings','launch')}" style="color:var(--text)">${esc(t('h_launch'))}</a><div class="sec meta">${esc(t('h_gates',{a:9,b:14}))}</div></span><span style="width:90px">${meter(9,14)}</span></li></ul></section></div>`;
 return h;};
function feedItem(f){return `<li data-id="${f.id}"><span class="ev ${f.cls}">${ic(f.icon,'sm')}</span><span class="t"><span class="pri" style="display:block;white-space:normal">${esc(tp([f.k,f.v]))}</span></span><span class="time" data-rel="${f.at}">${esc(rel(f.at))}</span></li>`;}
function sparkBars(arr){const W=300,Hh=72,max=Math.max(...arr,1),bw=W/arr.length;return `<svg viewBox="0 0 ${W} ${Hh+14}" role="img" aria-label="${esc(t('h_runsChart')+', '+t('h_last30m')+': '+arr.slice(-5).map(fN).join(', '))}"><line class="gl" x1="0" x2="${W}" y1="${Hh}" y2="${Hh}"/>${arr.map((v,i)=>{const h=Math.max(2,v/max*(Hh-4));return `<rect class="br" data-tipv="${fN(v)}" data-tipl="${esc(t('sx_minute'))} −${arr.length-1-i}" x="${i*bw+1}" y="${Hh-h}" width="${bw-2}" height="${h}" rx="2"/>`;}).join('')}<text class="ax" x="0" y="${Hh+12}">−30</text><text class="ax" x="${W}" y="${Hh+12}" text-anchor="end">0</text></svg><div class="ctip" aria-hidden="true"></div>`;}

/* ---------- Approvals inbox ---------- */
SCREENS['home/approvals']=()=>{
 const tab=curTab('inbox','waiting');
 const lists={waiting:waitingForMe(),mine:S.approvals.filter(a=>a.by===ME&&a.status==='pending'),done:S.approvals.filter(a=>a.status!=='pending')};
 let h=pageHead({title:t('approvals')})+tabsHtml('inbox',[['waiting',t('ib_waiting'),lists.waiting.length],['mine',t('ib_mine'),lists.mine.length],['done',t('ib_done'),null]],tab);
 const rows=lists[tab];
 h+=`<div class="card" role="tabpanel" aria-labelledby="tab-inbox-${tab}" id="inboxPanel">`;
 if(!rows.length)h+=emptyState('approve',t('ib_empty'));
 for(const a of rows){const own=a.by===ME;
  h+=`<article class="ap" id="ap-${a.id}" aria-labelledby="apt-${a.id}"><div class="top"><h2 class="ttl" id="apt-${a.id}">${esc(tp(a.title))}</h2><span class="meta num">${esc(a.id)}</span>${a.status!=='pending'?badge('st_'+a.status):`<span class="b warn">${esc(t('ib_expires',{when:rel(a.exp)}))}</span>`}</div>
  <div class="meta">${esc(t('ib_by',{who:own?ME:a.by}))} · ${esc(rel(a.at))} · <span>${esc(a.reason)}</span></div>${diffTable(a.diff)}`;
  if(a.status==='pending'){h+=`<div class="btns">`;
   if(tab==='mine')h+=`<button class="btn" data-act="withdraw" data-id="${a.id}" id="wd-${a.id}">${esc(t('ib_withdraw'))}</button>`;
   else h+=own?`<span class="hint"><button class="btn primary" aria-disabled="true" aria-describedby="own-${a.id}" data-act="hint" id="apb-${a.id}">${ic('check','sm')}${esc(t('approve'))}</button><span class="tip" role="tooltip" id="own-${a.id}">${esc(t('ib_own'))}</span></span>`:`<button class="btn primary" data-act="approve" data-id="${a.id}" id="apb-${a.id}">${ic('check','sm')}${esc(t('approve'))}</button><button class="btn" data-act="decline" data-id="${a.id}" id="dcb-${a.id}">${esc(t('decline'))}</button>`;
   h+=`</div>`;}
  h+=`</article>`;}
 return h+`</div>`;};

/* ---------- Support ---------- */
SCREENS['users/support']=(param)=>{if(param)return personDetail(param);
 const tab=curTab('support','cases');
 let h=pageHead({title:t('s_support'),acts:`<button class="btn primary" data-act="toast" data-m="newCase" id="newCaseBtn">${ic('plus','sm')}${esc(t('newCase'))}</button>`})+tabsHtml('support',[['cases',t('sp_cases'),CASES.filter(c=>c.status!=='cs_closed').length],['lookup',t('sp_lookup')],['recovery',t('sp_recovery')],['explainer',t('sp_explainer')]],tab);
 h+=`<div role="tabpanel" aria-labelledby="tab-support-${tab}">`;
 if(tab==='cases')h+=dataTable({id:'cases',rows:CASES,row:true,text:r=>r.id+' '+r.subject,name:r=>r.id,
  cols:[{key:'id',label:'ra_case',cls:'pr',sv:r=>r.id,r:r=>`<div>${rowBtn('cases',r.id,r.id)}<div class="sec">${esc(r.subject)}</div></div>`},
   {key:'p',label:'c_participant',sv:r=>personById(r.pid).name,r:r=>`<span lang="en">${esc(personById(r.pid).name)}</span>`},
   {key:'status',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)},
   {key:'opened',label:'c_opened',sv:r=>r.opened,r:r=>`<span class="num">${esc(rel(r.opened))}</span>`},
   {key:'as',label:'c_assignee',sv:r=>r.assignee,hide:true,r:r=>esc(r.assignee)}],
  filters:[{key:'status',label:'c_status',get:r=>r.status,opts:['cs_open','cs_waiting','cs_closed'].map(v=>[v,'@'+v])}]});
 else if(tab==='lookup'){const lk=S.lookup||{};h+=`<div class="card"><form class="card-b form" data-form="lookup" novalidate style="max-width:560px"><div class="grid g2"><div class="fld"><label for="lkq">${esc(t('lk_query'))}</label><input class="inp" id="lkq" name="q" autocomplete="off" value="${esc(lk.q||'')}"></div><div class="fld"><label for="lkc">${esc(t('ra_case'))}</label><select class="inp" id="lkc" name="c" aria-describedby="lkcErr" ${lk.err?'aria-invalid="true"':''}><option value="">—</option>${CASES.filter(c=>c.status!=='cs_closed').map(c=>`<option ${lk.c===c.id?'selected':''}>${c.id}</option>`).join('')}</select><span class="err" id="lkcErr">${lk.err?esc(t('lk_caseReq')):''}</span></div></div><div class="row"><button class="btn primary" type="submit" id="lkGo">${ic('search','sm')}${esc(t('lk_find'))}</button>${hint(t('ra_tip'))}</div></form>`;
  if(lk.found)h+=`<div class="pager" style="border-top:1px solid var(--border)"><span>${esc(t('lk_logged',{c:lk.c}))}</span></div><ul class="list" style="border-top:1px solid var(--border)">${PEOPLE.filter(p=>p.name.toLowerCase().includes((lk.q||'').toLowerCase())).slice(0,4).map(p=>`<li><a class="t pri" href="${href('users','support',p.id)}" lang="en" style="color:var(--text)">${esc(p.name)}</a>${badge(p.ver)}<a class="btn sm" href="${href('users','support',p.id)}">${esc(t('open'))}</a></li>`).join('')||`<li>${esc(t('noResults'))}</li>`}</ul>`;
  h+=`</div>`;}
 else h+=`<div class="card">${emptyState('content',t('notBuilt'),`<span class="b">${esc(t('designed'))}</span>`)}</div>`;
 return h+`</div>`;};
function personDetail(pid){const p=personById(pid)||PEOPLE[0];const tab=curTab('person','overview');const g=S.grant&&S.grant.pid===p.id?S.grant:null;
 let h=crumbs([[t('hubName'),href('home','overview')],[t('n_users'),href('users','people')],[t('s_support'),href('users','support')]])+`<div class="ph"><h1 tabindex="-1" id="pageTitle" lang="en">${esc(p.name)}</h1>${badge(p.ver)}${badge(p.status)}</div>`;
 const myCases=CASES.filter(c=>c.pid===p.id);
 h+=tabsHtml('person',[['overview',t('s_overview')],['cases',t('sp_cases'),myCases.length],['log',t('sp_log'),ACCESSLOG.length]],tab);
 h+=`<div role="tabpanel" aria-labelledby="tab-person-${tab}">`;
 if(tab==='overview'){const hid=`<span class="b nodot outline">${ic('lock','sm')} ${esc(t('hidden'))}</span>${hint(t('hiddenTip'))}`;
  h+=`<div class="grid g21"><section class="card" aria-labelledby="acctH"><div class="card-h"><h2 class="sh" id="acctH">${esc(t('k_account'))}</h2></div><div class="card-b">${kv([[t('k_email'),hid],[t('k_phone'),hid],[t('k_account'),badge(p.status)],[t('k_2fa'),`<span class="b ok">${esc(t('on'))}</span>`],[t('c_joined'),esc(fDate(p.joined))],[t('c_region'),`<span lang="en">${esc(p.county)}</span>`],[t('language'),'English'],[t('c_trade'),esc(t(p.trade))]])}</div></section>
  <section class="card" aria-labelledby="raH"><div class="card-h"><h2 class="sh" id="raH">${esc(t('ra_title'))}</h2><div class="acts">${hint(t('ra_tip'),null,true)}</div></div>`;
  if(g)h+=`<div class="card-b stack"><div class="row"><span class="b warn">${esc(t('ra_pending'))}</span><span class="meta num">${esc(g.ap)}</span></div>${kv([[t('ra_case'),esc(g.c)],[t('ra_scope'),esc(g.scopes.map(s=>t(s)).join(', '))],[t('ra_duration'),esc(unit(g.h,'hour'))]])}<button class="btn" data-act="withdraw" data-id="${g.ap}" id="grWd">${esc(t('ib_withdraw'))}</button></div>`;
  else{const e=S.raErr||{};h+=`<form class="card-b form" data-form="access" data-pid="${p.id}" novalidate>
   <div class="fld"><label for="raC">${esc(t('ra_case'))}</label><select class="inp" id="raC" name="c" aria-describedby="raCErr" ${e.c?'aria-invalid="true"':''}><option value="">—</option>${myCases.filter(c=>c.status!=='cs_closed').map(c=>`<option>${c.id}</option>`).join('')}</select><span class="err" id="raCErr">${e.c?esc(t('lk_caseReq')):''}</span></div>
   <fieldset class="fld" style="border:0;padding:0;margin:0" aria-describedby="raSErr"><legend class="lab" style="font-weight:500;font-size:var(--fs-sm);margin-bottom:6px">${esc(t('ra_scope'))}</legend><div class="row">${['ra_contact','ra_security','ra_projects'].map(s=>`<label class="row" style="gap:6px"><input type="checkbox" class="cb" name="s" value="${s}">${esc(t(s))}</label>`).join('')}</div><span class="err" id="raSErr">${e.s?esc(t('ra_scopeReq')):''}</span></fieldset>
   <div class="fld"><span class="lab" id="raDL">${esc(t('ra_duration'))}</span><div class="seg" role="radiogroup" aria-labelledby="raDL">${[24,48,72].map((n,i)=>`<label><input type="radio" name="d" value="${n}" ${i===0?'checked':''}>${esc(unit(n,'hour'))}</label>`).join('')}</div></div>
   <div class="fld"><label for="raR">${esc(t('reason'))}</label><input class="inp" id="raR" name="r" aria-describedby="raRErr" ${e.r?'aria-invalid="true"':''}><span class="err" id="raRErr">${e.r?esc(t('reasonReq')):''}</span></div>
   <div><button class="btn primary" type="submit" id="raGo">${esc(t('ra_title'))}</button></div></form>`;}
  h+=`</section></div>`;}
 else if(tab==='cases')h+=dataTable({id:'pcases',rows:myCases,cols:[{key:'id',label:'ra_case',cls:'pr',sv:r=>r.id,r:r=>`<span class="pri">${esc(r.id)}</span>`},{key:'s',label:'c_subject',sv:r=>r.subject,r:r=>`<span>${esc(r.subject)}</span>`},{key:'st',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)},{key:'o',label:'c_opened',sv:r=>r.opened,r:r=>esc(fDT(r.opened))}]});
 else h+=dataTable({id:'plog',rows:ACCESSLOG.map((x,i)=>({...x,id:'l'+i})),cols:[{key:'at',label:'c_time',cls:'pr',sv:r=>r.at,r:r=>`<span class="num">${esc(fDT(r.at))}</span>`},{key:'st',label:'c_staff',sv:r=>r.staff,r:r=>esc(r.staff)},{key:'a',label:'c_action',sv:r=>r.action,r:r=>esc(t(r.action))},{key:'c',label:'ra_case',sv:r=>r.cs,r:r=>esc(r.cs)}]});
 return h+`</div>`;}

/* ---------- Staff and roles ---------- */
const MATRIX={rows:['p_viewSettings','p_changeSettings','p_approvePrices','p_decideClaims','p_approveAccess','p_moderate','p_audit','p_kill','p_staff','p_erase'],roles:['r_owner','r_supLead','r_supAgent','r_mod','r_comm','r_comp','r_aud'],
 g:{r_owner:[1,1,1,1,1,0,1,1,1,0],r_supLead:[1,0,0,1,1,0,0,0,0,0],r_supAgent:[1,0,0,0,0,0,0,0,0,0],r_mod:[1,0,0,0,0,1,0,0,0,0],r_comm:[1,1,1,0,0,0,0,0,0,0],r_comp:[1,0,0,1,0,0,1,1,0,1],r_aud:[1,0,0,0,0,0,1,0,0,0]},locked:['p_impersonate','p_ranking']};
SCREENS['users/staff']=()=>{const tab=curTab('staff','dir');
 let h=pageHead({title:t('s_staff'),acts:`<button class="btn primary" data-act="invite" id="inviteBtn">${ic('plus','sm')}${esc(t('invite'))}</button>`})+tabsHtml('staff',[['dir',t('s_directory'),STAFF.length],['roles',t('st_tabRoles')],['inv',t('st_tabInv'),1],['rev',t('st_tabReviews')]],tab);
 h+=`<div role="tabpanel" aria-labelledby="tab-staff-${tab}">`;
 if(tab==='dir')h+=dataTable({id:'staff',rows:STAFF,select:true,name:r=>r.name,text:r=>r.name+' '+r.roles.map(x=>t(x)).join(' '),bulk:[['export','export','download']],
  cols:[{key:'name',label:'c_name',cls:'pr',sv:r=>r.name,r:r=>`<span class="pri">${esc(r.name)}</span>`},{key:'roles',label:'c_roles',sv:r=>t(r.roles[0]),r:r=>r.roles.map(x=>`<span class="b outline nodot">${esc(t(x))}</span>`).join(' ')},{key:'scope',label:'ra_scope',sv:r=>r.scope,hide:true,r:r=>esc(t(r.scope==='node'?'nodeLbl':'hubLbl'))},{key:'mfa',label:'k_2fa',sv:r=>r.mfa,r:r=>r.mfa?`<span class="b ok">${esc(t('on'))}</span>`:`<span class="b warn">${esc(t('off'))}</span>`},{key:'ends',label:'c_ends',sv:r=>r.ends||9e15,hide:true,r:r=>r.ends?`<span class="num">${esc(fDate(r.ends))}</span>`:`<span class="meta">${esc(t('noEnd'))}</span>`},{key:'status',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)}],
  filters:[{key:'role',label:'c_role',get:r=>r.roles[0],opts:MATRIX.roles.concat('r_editor').map(x=>[x,'@'+x])}]});
 else if(tab==='roles'){h+=`<div class="card"><div class="card-h"><h2 class="sh">${esc(t('st_tabRoles'))}</h2><div class="acts meta row" style="gap:12px"><span>${ic('check','sm')} ${esc(t('granted'))}</span><span>${ic('minus','sm')} ${esc(t('notGranted'))}</span><span>${ic('lock','sm')} ${esc(t('never'))}</span></div></div><p class="phone-only meta" style="margin:8px 16px 0">${esc(t('wideNote'))}</p><div class="tblwrap" role="region" tabindex="0" aria-label="${esc(t('st_tabRoles'))}"><table class="mx"><caption class="vh">${esc(t('st_tabRoles'))}</caption><thead><tr><th scope="col" style="text-align:left">${esc(t('c_permission'))}</th>${MATRIX.roles.map(r=>`<th scope="col">${esc(t(r))}</th>`).join('')}</tr></thead><tbody>`;
  MATRIX.rows.forEach((p,i)=>{h+=`<tr><th scope="row">${esc(t(p))}</th>${MATRIX.roles.map(r=>MATRIX.g[r][i]?`<td><span class="y">${ic('check','sm')}</span><span class="vh">${esc(t('granted'))}</span></td>`:`<td><span class="no">${ic('minus','sm')}</span><span class="vh">${esc(t('notGranted'))}</span></td>`).join('')}</tr>`;});
  MATRIX.locked.forEach(p=>{h+=`<tr><th scope="row"><span class="row" style="gap:6px">${esc(t(p))}${hint(t('lockedNever'))}</span></th>${MATRIX.roles.map(()=>`<td><span class="lk">${ic('lock','sm')}</span><span class="vh">${esc(t('never'))}</span></td>`).join('')}</tr>`;});
  h+=`</tbody></table></div></div>`;}
 else h+=`<div class="card">${emptyState('users',t('notBuilt'),`<span class="b">${esc(t('designed'))}</span>`)}</div>`;
 return h+`</div>`;};

/* ---------- Content queue ---------- */
const whoLabel=w=>{const a=agentById(w);return a?`<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="b ai nodot">${ic('spark','sm')}${esc(t('agentTag'))}</span>${esc(a.name)}</span>`:esc(w);};
SCREENS['content/queue']=()=>{const tab=curTab('queue','all');const by=s=>CONTENT.filter(c=>c.stage===s);
 const rows=tab==='all'?CONTENT:tab==='review'?by('cq_review'):tab==='fact'?by('cq_fact'):by('s_legal');
 let h=pageHead({title:t('s_queue')})+tabsHtml('queue',[['all',t('all'),CONTENT.length],['review',t('cq_review'),by('cq_review').length],['fact',t('cq_fact'),by('cq_fact').length],['legal',t('s_legal'),by('s_legal').length]],tab);
 h+=`<div role="tabpanel" aria-labelledby="tab-queue-${tab}">`+dataTable({id:'queue-'+tab,rows,row:true,select:true,name:r=>r.title,text:r=>r.title,bulk:[['export','export','download']],
  cols:[{key:'title',label:'c_title',cls:'pr',sv:r=>r.title,r:r=>`<div>${rowBtn('queue-'+tab,r.id,r.title)}</div>`},
   {key:'fmt',label:'c_format',sv:r=>t(r.fmt),r:r=>esc(t(r.fmt))},
   {key:'langs',label:'s_locales',hide:true,r:r=>r.langs.map(l=>`<span class="b outline nodot">${l}</span>`).join(' ')},
   {key:'stage',label:'c_stage',sv:r=>r.stage,r:r=>badge(r.stage)},
   {key:'who',label:'c_assignee',sv:r=>(agentById(r.who)||{name:r.who}).name,hide:true,r:r=>whoLabel(r.who)},
   {key:'due',label:'c_due',sv:r=>r.due,r:r=>`<span class="num ${r.due<NOW+3*H&&r.stage!=='sg_published'?'down':''}">${esc(rel(r.due))}</span>`}],
  filters:[{key:'fmt',label:'c_format',get:r=>r.fmt,opts:['fm_news','fm_guide','fm_event','fm_correction'].map(v=>[v,'@'+v])},...(tab==='all'?[{key:'stage',label:'c_stage',get:r=>r.stage,opts:['sg_intake','sg_drafting','cq_fact','cq_review','s_legal','sg_scheduled','sg_published','sg_returned'].map(v=>[v,'@'+v])}]:[])]})+`</div>`;
 return h;};

/* ---------- Automation: live runs ---------- */
SCREENS['automation/runs']=()=>{const ks=S.kill.ks_dispatch.on;
 let h=pageHead({title:t('s_runs'),badge:`<span class="livedot ${S.live&&!ks?'':'off'}" id="liveState">${esc(t(S.live&&!ks?'h_live':'h_paused'))}</span>`,acts:`<button class="btn sm" data-act="live" id="liveBtn" aria-pressed="${!S.live}">${ic(S.live?'pause':'play','sm')}${esc(t(S.live?'h_pauseLive':'h_resumeLive'))}</button><button class="btn sm danger" data-act="engage" data-k="ks_dispatch" id="pauseAllBtn" ${ks?'disabled':''}>${ic('power','sm')}${esc(t('pauseAll'))}</button>`});
 h+=`<div class="grid g4" style="margin-bottom:var(--s4)">${[['running','run_running',runningRuns().length],['ok','run_ok',S.okToday],['review','run_review',S.reviewToday],['fail','run_fail',S.failToday]].map(([id,k,v])=>`<div class="card kpi"><span class="k">${badge(k)}</span><span class="v" data-live="r-${id}">${fN(v)}</span></div>`).join('')}</div>`;
 h+=`<div id="runsTable">${runsTable()}</div>`;return h;};
function runsTable(){return dataTable({id:'runs',rows:S.runs.slice(0,40),row:true,pageSize:12,name:r=>r.id,text:r=>r.id+' '+agentById(r.agent).name,
 cols:[{key:'id',label:'c_run',cls:'pr',sv:r=>r.id,r:r=>`<div>${rowBtn('runs',r.id,r.id)}<div class="sec">${esc(t(agentById(r.agent).task))}</div></div>`},
  {key:'agent',label:'c_agent',sv:r=>agentById(r.agent).name,r:r=>`<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="ev ai" style="width:22px;height:22px;border-radius:6px">${ic('spark','sm')}</span>${esc(agentById(r.agent).name)}</span>`},
  {key:'start',label:'c_started',sv:r=>r.start,hide:true,r:r=>`<span class="num">${esc(fTime(r.start))}</span>`},
  {key:'dur',label:'c_duration',sv:r=>(r.end||Date.now())-r.start,r:r=>`<span class="num" ${r.status==='run_running'?`data-dur="${r.start}"`:''}>${esc(fDur(((r.end||Date.now())-r.start)/1000))}</span>`},
  {key:'status',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)},
  {key:'cost',label:'c_spend',cls:'n',sv:r=>r.cost,hide:true,r:r=>`<span class="num">${esc(fUSD(r.cost))}</span>`}],
 filters:[{key:'status',label:'c_status',get:r=>r.status,opts:['run_running','run_ok','run_review','run_fail','run_unknown','run_stopped'].map(v=>[v,'@'+v])},{key:'agent',label:'c_agent',get:r=>r.agent,opts:AGENTS.map(a=>[a.id,a.name])}]});}

/* ---------- Agent team ---------- */
SCREENS['automation/team']=()=>{let h=pageHead({title:t('s_agentTeam'),acts:`<div class="row" style="gap:6px">${lockBadge('lk_mandate','lk_mandateTip')}${lockBadge('lk_neutral','lk_neutralTip')}</div>`});
 h+=`<div id="teamTable">`+dataTable({id:'team',rows:AGENTS,name:r=>r.name,text:r=>r.name+' '+t(r.role),
  cols:[{key:'name',label:'c_agent',cls:'pr',sv:r=>r.name,r:r=>`<div><span class="pri">${esc(r.name)}</span><div class="sec">${esc(t(r.role))}</div></div>`},
   {key:'area',label:'c_area',sv:r=>t(r.area),hide:true,r:r=>esc(t(r.area))},
   {key:'aut',label:'c_autonomy',sv:r=>r.aut,r:r=>`<span class="b outline nodot">${esc(t(r.aut))}</span>`},
   {key:'acc',label:'c_accountable',sv:r=>r.acc,hide:true,r:r=>esc(r.acc)},
   {key:'budget',label:'c_budget',sv:r=>r.spent/r.cap,r:r=>`<div class="budget">${meter(r.spent,r.cap)}<span class="sec num">${esc(fUSD(r.spent)+' / '+fUSD(r.cap,0))}</span></div>`},
   {key:'state',label:'c_status',sv:r=>r.state,r:r=>badge(r.state)},
   {key:'act',label:'more',cls:'act',r:r=>r.state==='st_stopped'?`<button class="btn sm" data-act="restart" data-id="${r.id}" id="rs-${r.id}">${ic('play','sm')}${esc(t('resume'))}</button>`:`<button class="btn sm" data-act="pausea" data-id="${r.id}" id="pa-${r.id}">${ic(r.state==='st_paused'?'play':'pause','sm')}${esc(t(r.state==='st_paused'?'resume':'pause'))}</button> <button class="btn sm ghost" data-act="stopa" data-id="${r.id}" id="sa-${r.id}" style="color:var(--bad)">${ic('power','sm')}${esc(t('stop'))}</button>`}],
  filters:[{key:'area',label:'c_area',get:r=>r.area,opts:['area_support','area_editorial','area_ops'].map(v=>[v,'@'+v])},{key:'state',label:'c_status',get:r=>r.state,opts:['st_active','st_paused','st_stopped'].map(v=>[v,'@'+v])}]})+`</div>`;
 return h;};

/* ---------- Models and prices ---------- */
SCREENS['automation/models']=()=>{const tab=curTab('models','models');
 let h=pageHead({title:t('s_models'),acts:`<button class="btn primary" data-act="newprice" id="npBtn">${ic('plus','sm')}${esc(t('newPrice'))}</button>`});
 h+=`<div class="row" style="margin:-4px 0 var(--s4);gap:6px"><span class="meta">${esc(t('guardRails'))}</span>${lockBadge('lk_neutral','lk_neutralTip')}${lockBadge('lk_mandate','lk_mandateTip')}${lockBadge('lk_sanctions','lk_sanctionsTip')}${lockBadge('lk_places','lk_placesTip')}</div>`;
 h+=tabsHtml('models',[['models',t('mp_models'),MODELS.length],['prices',t('s_prices'),PRICES.length]],tab)+`<div role="tabpanel" aria-labelledby="tab-models-${tab}">`;
 if(tab==='models')h+=dataTable({id:'models',rows:MODELS,name:r=>r.name,
  cols:[{key:'name',label:'c_model',cls:'pr',sv:r=>r.name,r:r=>`<span class="pri" style="font-family:var(--font-mono);font-size:13px">${esc(r.name)}</span>`},{key:'prov',label:'c_provider',sv:r=>r.provider,r:r=>`<span>${esc(r.provider==='Self-hosted'?t('fx_selfHosted'):r.provider)}</span>`},{key:'ev',label:'c_eval',sv:r=>r.ev,r:r=>badge(r.ev)},{key:'cost',label:'c_costTok',cls:'n',sv:r=>r.cin,r:r=>`<span class="num">${esc(fUSD(r.cin)+' / '+fUSD(r.cout))}</span>`},{key:'route',label:'c_route',sv:r=>r.route,r:r=>badge(r.route)},{key:'st',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)}]});
 else h+=dataTable({id:'prices',rows:PRICES,name:r=>t(r.cap),
  cols:[{key:'cap',label:'c_capability',cls:'pr',sv:r=>t(r.cap),r:r=>`<div><span class="pri">${esc(t(r.cap))}</span><div class="sec">${esc(t(r.unit))}</div></div>`},{key:'cost',label:'c_cost',cls:'n',sv:r=>r.cost,r:r=>`<span class="num">${esc(fUSD(r.cost))}</span>`},{key:'price',label:'f_price',cls:'n',sv:r=>r.price,r:r=>`<span class="num pri">${esc(fUSD(r.price))}</span>`},{key:'margin',label:'c_margin',cls:'n',sv:r=>(r.price-r.cost)/r.price,r:r=>{const m=(r.price-r.cost)/r.price;return `<span class="num ${m<0?'down':''}">${esc(fPct(m,true))}</span>`;}},{key:'v',label:'c_version',cls:'n',sv:r=>r.v,r:r=>`<span class="num">v${r.v}</span>`},{key:'st',label:'c_status',sv:r=>r.status,r:r=>r.pending?badge('st_pending'):badge(r.status)}]});
 return h+`</div>`;};

/* ---------- Kill switches ---------- */
function killTable(){return `<div class="tblwrap"><table class="dt"><thead><tr><th scope="col">${esc(t('c_switch'))}</th><th scope="col">${esc(t('f_state'))}</th><th scope="col">${esc(t('c_engagedBy'))}</th><th scope="col" class="act"><span class="vh">${esc(t('c_action'))}</span></th></tr></thead><tbody>${Object.entries(S.kill).map(([k,v])=>`<tr><td class="pr"><span class="pri">${esc(t(k))}</span></td><td data-label="${esc(t('f_state'))}">${v.on?badge('engaged'):`<span class="b ok">${esc(t('off'))}</span>`}</td><td data-label="${esc(t('c_engagedBy'))}">${v.on?esc(v.by+' · '+rel(v.at)):'—'}</td><td class="act">${v.on?(v.rel?`<span class="b warn">${esc(t('ra_pending'))}</span>`:`<button class="btn sm" data-act="release" data-k="${k}" id="rl-${k}">${esc(t('reqRelease'))}</button>`):`<button class="btn sm danger" data-act="engage" data-k="${k}" id="en-${k}">${ic('power','sm')}${esc(t('engage'))}</button>`}</td></tr>`).join('')}</tbody></table></div>`;}
SCREENS['automation/kill']=()=>pageHead({title:t('s_kill')})+`<div class="card">${killTable()}</div>`;

/* ---------- Settings: modes with diff and approval ---------- */
SCREENS['settings/modes']=()=>{const tab=curTab('modes','config');const d=S.draft||S.modes;const ch=k=>S.draft&&S.draft[k]!==S.modes[k];
 let h=pageHead({title:t('s_modes'),badge:`<span class="meta num">v${MODE_VERSIONS[0].v}</span>`});
 if(S.modesPending)h+=`<div class="card" style="margin-bottom:var(--s4);border-color:var(--warn-s)"><div class="card-h" style="border:0"><span class="b warn">${esc(t('set_pending',{v:S.modesPending.v}))}</span><span class="meta num">${esc(S.modesPending.ap)}</span><div class="acts"><a href="${href('home','approvals')}" class="btn sm" data-tab="mine">${esc(t('approvals'))}</a></div></div></div>`;
 h+=tabsHtml('modes',[['config',t('set_config')],['history',t('set_history'),MODE_VERSIONS.length]],tab)+`<div role="tabpanel" aria-labelledby="tab-modes-${tab}">`;
 if(tab==='config'){const seg=(k,opts)=>`<div class="seg" role="radiogroup" aria-labelledby="lab-${k}">${opts.map(o=>`<label><input type="radio" name="${k}" value="${o}" data-in="mode" data-k="${k}" ${d[k]===o?'checked':''} ${S.modesPending?'disabled':''}>${esc(t(o))}</label>`).join('')}</div>`;
  const sw=k=>`<label class="switch"><input type="checkbox" role="switch" data-in="mode" data-k="${k}" aria-labelledby="lab-${k}" ${d[k]?'checked':''} ${S.modesPending?'disabled':''}><span class="tr"></span><span>${esc(t(d[k]?'on':'off'))}</span></label>`;
  h+=`<div class="card"><div class="setrow ${ch('registration')?'changed':''}"><span class="lab" id="lab-registration">${esc(t('f_registration'))}</span>${seg('registration',['reg_closed','reg_invite','reg_open'])}</div>
  <div class="setrow ${ch('moderation')?'changed':''}"><span class="lab" id="lab-moderation">${esc(t('s_moderation'))}</span>${seg('moderation',['mod_pre','mod_post'])}</div>
  <div class="setrow ${ch('indexing')?'changed':''}"><span class="lab" id="lab-indexing">${esc(t('f_indexing'))}${hint(t('set_secondTip'))}</span>${sw('indexing')}</div>
  <div class="setrow ${ch('maintenance')?'changed':''}"><span class="lab" id="lab-maintenance">${esc(t('f_maint'))}</span>${sw('maintenance')}</div>`;
  const n=S.draft?Object.keys(S.modes).filter(k=>ch(k)).length:0;
  h+=`<div class="card-h" style="border-top:1px solid var(--border);border-bottom:0;background:var(--surface-2);border-radius:0 0 var(--r-lg) var(--r-lg)"><span class="meta" aria-live="polite">${n?esc(t('set_changes'))+': '+fN(n):esc(t('set_noChanges'))}</span><div class="acts"><button class="btn" data-act="discard" id="mdDiscard" ${n?'':'disabled'}>${esc(t('discard'))}</button><button class="btn primary" data-act="reviewmodes" id="mdReview" ${n?'':'disabled'}>${esc(t('reviewChanges'))}</button></div></div></div>`;}
 else h+=dataTable({id:'mhist',rows:MODE_VERSIONS.map(v=>({...v,id:'v'+v.v})),cols:[{key:'v',label:'c_version',cls:'pr',sv:r=>r.v,r:r=>`<span class="pri num">v${r.v}</span>`},{key:'by',label:'c_changedBy',sv:r=>r.by,r:r=>esc(r.by)},{key:'ap',label:'c_approvedBy',sv:r=>r.ap,r:r=>esc(r.ap)},{key:'at',label:'c_activated',sv:r=>r.at,r:r=>`<span class="num">${esc(fDate(r.at))}</span>`},{key:'st',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)}]});
 return h+`</div>`;};
const modeVal=(k,v)=>typeof v==='boolean'?'@'+(v?'on':'off'):'@'+v;
const MODE_LABEL={registration:'f_registration',moderation:'s_moderation',indexing:'f_indexing',maintenance:'f_maint'};

/* ---------- Incidents ---------- */
const INCIDENTS=[{id:'INC-0042',title:'inc_t1',sev:2,status:'inc_investigating',start:NOW-47*M,lead:ME},{id:'INC-0039',title:'inc_t2',sev:3,status:'inc_resolved',start:NOW-4*D,lead:'Synthetic Compliance F'}];
SCREENS['ops/incidents']=(param)=>{if(param)return incidentDetail(param);
 return pageHead({title:t('s_incidents')})+dataTable({id:'inc',rows:INCIDENTS,row:true,name:r=>r.id,
  cols:[{key:'id',label:'t_case',cls:'pr',sv:r=>r.id,r:r=>`<div>${rowBtn('inc',r.id,r.id)}<div class="sec">${esc(t(r.title))}</div></div>`},{key:'sev',label:'c_severity',sv:r=>r.sev,r:r=>`<span class="b ${r.sev<=2?'bad':'warn'}">${esc(t('sev',{n:r.sev}))}</span>`},{key:'st',label:'c_status',sv:r=>r.status,r:r=>badge(r.status)},{key:'start',label:'c_started',sv:r=>r.start,r:r=>`<span class="num">${esc(fDT(r.start))}</span>`},{key:'lead',label:'c_lead',sv:r=>r.lead,hide:true,r:r=>esc(r.lead)}]});};
function incidentDetail(id){const inc=INCIDENTS.find(i=>i.id===id)||INCIDENTS[0];
 let h=crumbs([[t('hubName'),href('home','overview')],[t('n_ops'),href('ops','health')],[t('s_incidents'),href('ops','incidents')]])+`<div class="ph"><h1 tabindex="-1" id="pageTitle">${esc(inc.id)} · ${esc(t(inc.title))}</h1><span class="b ${inc.sev<=2?'bad':'warn'}">${esc(t('sev',{n:inc.sev}))}</span>${badge(inc.status)}</div>`;
 h+=`<div class="grid g21"><section class="card" aria-labelledby="tlH"><div class="card-h"><h2 class="sh" id="tlH">${esc(t('inc_timeline'))}</h2></div><div class="card-b"><ol class="tl" id="incTl">${[...S.incTimeline].reverse().map(e=>`<li class="${e.cls}"><div class="pri" style="font-weight:500">${esc(t(e.k))}</div><div class="meta"><span class="num">${esc(fTime(e.at))}</span> · ${esc(e.who)}${e.note?` · <span>${esc(e.note)}</span>`:''}</div></li>`).join('')}</ol></div></section>
 <div class="stack"><section class="card" aria-labelledby="ksH"><div class="card-h"><h2 class="sh" id="ksH">${esc(t('s_kill'))}</h2></div>${killTable()}</section>
 <section class="card" aria-labelledby="dH"><div class="card-h"><h2 class="sh" id="dH">${esc(t('details'))}</h2></div><div class="card-b">${kv([[t('c_started'),esc(fDT(inc.start))],[t('c_lead'),esc(inc.lead)],[t('c_severity'),esc(t('sev',{n:inc.sev}))],[t('c_switch'),esc(t('ks_dispatch'))]])}</div></section></div></div>`;
 return h;}

/* ---------- Statistics ---------- */
const WEEKLY=[812,846,871,905,889,934,978,1011,1046,1102,1188,1284];
SCREENS['stats/dashboards']=()=>{const per=S.period||'30';const k=per==='30'?1:per==='90'?2.8:10.5;
 const tile=(lab,val,delta,good,def)=>`<div class="card kpi"><span class="k">${esc(lab)}${def?hint(def):''}</span><span class="v">${val}</span><span class="d ${good?'up':'down'}">${ic(delta>=0?'up':'down','sm')}${esc(fPct(delta,true))} <span class="meta">${esc(t('sx_vsPrev'))}</span></span></div>`;
 let h=pageHead({title:t('s_dashboards'),acts:`<label class="vh" for="perSel">${esc(t('sx_period'))}</label><select class="inp" id="perSel" data-in="period">${[['30','sx_30'],['90','sx_90'],['365','sx_12m']].map(([v,l])=>`<option value="${v}" ${per===v?'selected':''}>${esc(t(l))}</option>`).join('')}</select><button class="btn" data-act="toast" data-m="toast_exported" id="stExport">${ic('download','sm')}${esc(t('export'))}</button>`});
 h+=`<div class="grid g4" style="margin-bottom:var(--s4)">${tile(t('sx_active'),fN(Math.round(1284*Math.min(k,1.6))),.08,true,t('sx_activeDef'))}${tile(t('sx_projects'),fN(Math.round(96*k)),.12,true)}${tile(t('sx_confirmed'),fN(Math.round(412*k)),-.03,false)}${tile(t('sx_response'),esc(unit(3.4,'hour')),-.1,true)}</div>`;
 h+=`<div class="grid g2" style="margin-bottom:var(--s4)">${chartCard('wk',t('sx_weekly'),WEEKLY.map((v,i)=>[t('sx_week')+' '+(i+1),Math.round(v*Math.min(k,1.3))]),'line')}${chartCard('st',t('sx_byState'),[[t('ps_planning'),Math.round(41*k)],[t('ps_hiring'),Math.round(23*k)],[t('ps_progress'),Math.round(58*k)],[t('ps_done'),Math.round(37*k)]],'bar')}</div>`;
 const reg=[['San Diego',Math.round(214*k),Math.round(38*k)],['Riverside',Math.round(31*k),Math.round(6*k)],['Orange',Math.round(18*k),Math.round(4*k)],['Imperial',Math.round(7*k),Math.round(2*k)]];
 const cell=n=>n<10?`<span class="row" style="gap:4px;justify-content:flex-end;flex-wrap:nowrap"><span class="num meta">&lt;10</span>${hint(t('sx_suppTip'),null,true)}</span>`:`<span class="num">${fN(n)}</span>`;
 h+=`<section class="card" aria-labelledby="regH"><div class="card-h"><h2 class="sh" id="regH">${esc(t('sx_byRegion'))}</h2></div><div class="tblwrap"><table class="dt" aria-labelledby="regH"><thead><tr><th scope="col">${esc(t('c_county'))}</th><th scope="col" class="n">${esc(t('s_people'))}</th><th scope="col" class="n">${esc(t('s_companies'))}</th></tr></thead><tbody>${reg.map(r=>`<tr><td class="pr" lang="en"><span class="pri">${esc(r[0])}</span></td><td class="n" data-label="${esc(t('s_people'))}">${cell(r[1])}</td><td class="n" data-label="${esc(t('s_companies'))}">${cell(r[2])}</td></tr>`).join('')}</tbody></table></div></section>`;
 return h;};
function chartCard(id,title,data,kind){const mode=S.tabs['ch-'+id]||'chart';
 return `<section class="card" aria-labelledby="ch-${id}-h"><div class="card-h"><h2 class="sh" id="ch-${id}-h">${esc(title)}</h2><div class="acts"><div class="views" role="group" aria-label="${esc(title)}">${[['chart','sx_chart'],['table','sx_table']].map(([v,l])=>`<button type="button" aria-pressed="${mode===v}" data-act="chmode" data-c="${id}" data-v="${v}" id="chm-${id}-${v}">${esc(t(l))}</button>`).join('')}</div></div></div><div class="card-b">${mode==='chart'?(kind==='line'?lineChart(data,title):barChart(data,title)):`<table class="diff"><thead><tr><th scope="col">${esc(kind==='line'?t('sx_week'):t('c_stage'))}</th><th scope="col" style="text-align:right">${esc(t('sx_value'))}</th></tr></thead><tbody>${data.map(([l,v])=>`<tr><td>${esc(l)}</td><td style="text-align:right" class="num">${fN(v)}</td></tr>`).join('')}</tbody></table>`}</div></section>`;}
function niceMax(m){const p=Math.pow(10,Math.floor(Math.log10(m)));const n=m/p;return(n<=1?1:n<=2?2:n<=5?5:10)*p;}
function lineChart(data,title){const W=520,Hh=200,pl=44,pb=24,pt=8,max=niceMax(Math.max(...data.map(d=>d[1])));const x=i=>pl+i*(W-pl-8)/(data.length-1),y=v=>pt+(Hh-pt-pb)*(1-v/max);
 const pts=data.map((d,i)=>[x(i),y(d[1])]);const path='M'+pts.map(p=>p.join(',')).join(' L');
 let g='';for(let i=0;i<=4;i++){const v=max*i/4;g+=`<line class="gl" x1="${pl}" x2="${W-8}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pl-6}" y="${y(v)+4}" text-anchor="end">${fN(v)}</text>`;}
 return `<div class="chart" data-chart="line"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(title)}: ${esc(fN(data[0][1]))} → ${esc(fN(data[data.length-1][1]))}">${g}<path class="ar" d="${path} L${x(data.length-1)},${y(0)} L${pl},${y(0)} Z"/><path class="ln" d="${path}"/>${data.map((d,i)=>i%3===0||i===data.length-1?`<text class="ax" x="${x(i)}" y="${Hh-6}" text-anchor="middle">${i+1}</text>`:'').join('')}<line class="xh" x1="0" x2="0" y1="${pt}" y2="${Hh-pb}" style="display:none"/><circle class="pt" r="4" cx="0" cy="0" style="display:none"/>${data.map((d,i)=>`<rect x="${x(i)-(W-pl)/(data.length-1)/2}" y="${pt}" width="${(W-pl)/(data.length-1)}" height="${Hh-pt-pb}" fill="transparent" data-hx="${x(i)}" data-hy="${y(d[1])}" data-tipl="${esc(d[0])}" data-tipv="${fN(d[1])}"/>`).join('')}</svg><div class="ctip" aria-hidden="true"></div></div>`;}
function barChart(data,title){const W=520,Hh=200,pl=44,pb=24,pt=18,max=niceMax(Math.max(...data.map(d=>d[1])));const bw=(W-pl-8)/data.length;const y=v=>pt+(Hh-pt-pb)*(1-v/max);
 let g='';for(let i=0;i<=4;i++){const v=max*i/4;g+=`<line class="gl" x1="${pl}" x2="${W-8}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${pl-6}" y="${y(v)+4}" text-anchor="end">${fN(v)}</text>`;}
 return `<div class="chart" data-chart="bar"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(title)}: ${esc(data.map(d=>d[0]+' '+fN(d[1])).join(', '))}">${g}${data.map((d,i)=>{const bx=pl+i*bw+bw*.2,h=y(0)-y(d[1]);return `<rect class="br" x="${bx}" y="${y(d[1])}" width="${bw*.6}" height="${h}" rx="4" data-tipl="${esc(d[0])}" data-tipv="${fN(d[1])}"/><text class="ax" x="${bx+bw*.3}" y="${y(d[1])-5}" text-anchor="middle" style="fill:var(--text-2);font-weight:600">${fN(d[1])}</text><text class="ax" x="${bx+bw*.3}" y="${Hh-6}" text-anchor="middle">${esc(d[0])}</text>`;}).join('')}</svg><div class="ctip" aria-hidden="true"></div></div>`;}

/* ---------- Designed placeholder ---------- */
function designed(sec,item){const s=secById(sec);const it=s?s.items.find(i=>i[0]===item):null;const title=it?t(it[1]):t('nodeConsole');const doc=item==='outreach'?'docs/engine/discovery-and-outreach.md':(DOCS[sec]||'docs/engine/hub-console/screens.md');
 return pageHead({title,badge:`<span class="b">${esc(t('designed'))}</span>`})+`<div class="card">${emptyState(s?s.icon:'network',t('notBuilt'),`<a class="btn sm" href="https://github.com/Contribuda/trustwork/blob/main/${doc}" target="_blank" rel="noopener">${ic('ext','sm')}${esc(t('openDesign'))}</a><span class="meta" style="font-family:var(--font-mono);font-size:12px">${esc(doc)}</span>`)}</div>`;}
