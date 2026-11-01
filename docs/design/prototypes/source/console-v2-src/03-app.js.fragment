<script>
'use strict';
/* ================= Core helpers ================= */
const TZ='America/Los_Angeles';
const MODK=/Mac|iPhone|iPad/.test(navigator.platform||'')?'⌘':'Ctrl';
const HUB_SLUG='san-diego';
let li=0;
try{const s=localStorage.getItem('tw2-lang');if(s!==null&&LANGS[+s])li=+s;}catch(e){}
const tag=()=>LANGS[li][0];
function t(k,v){const e=T[k];if(!e){console.warn('missing key',k);return k;}let s=e[li]||e[0];if(v)for(const a in v)s=s.split('{'+a+'}').join(v[a]);return s;}
function tp(spec){if(!spec)return'';if(typeof spec==='string')return t(spec);const[k,v]=spec;const o={};for(const a in v){const x=v[a];o[a]=(typeof x==='string'&&x[0]==='@')?t(x.slice(1)):x;}return t(k,o);}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function intl(fn){try{return fn(tag());}catch(e){return fn('en');}}
const fN=n=>L10N.num(n);
const fUSD=(n,d=2)=>L10N.money(n,{minimumFractionDigits:d,maximumFractionDigits:d});
const fPct=(n,sign)=>L10N.num(n*100,{maximumFractionDigits:0,signDisplay:sign?'exceptZero':'auto'})+'%';
const fDate=ts=>L10N.date(ts,{dateStyle:'medium',timeZone:TZ});
const fTime=ts=>L10N.date(ts,{timeStyle:'medium',timeZone:TZ});
const fDT=ts=>L10N.date(ts,{dateStyle:'medium',timeStyle:'short',timeZone:TZ});
const unit=prototypeUnit;
function rel(ts){const d=(ts-Date.now())/1000,a=Math.abs(d);return a<45?prototypeRelative(Math.round(d),'second'):a<3600?prototypeRelative(Math.round(d/60),'minute'):a<86400?prototypeRelative(Math.round(d/3600),'hour'):prototypeRelative(Math.round(d/86400),'day');}
function fDur(sec){sec=Math.max(0,Math.round(sec));if(sec<60)return unit(sec,'second');const m=Math.floor(sec/60),s=sec%60;if(m<60)return unit(m,'minute')+' '+unit(s,'second');return unit(Math.floor(m/60),'hour')+' '+unit(m%60,'minute');}
const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const NOW=Date.now();const H=3600e3,D=86400e3,M=60e3;
let uid=0;const nid=p=>(p||'x')+(++uid);
function rnd(seed){let x=seed;return()=>{x=(x*1103515245+12345)%2147483648;return x/2147483648;};}
const R=rnd(42);
function announce(msg){const a=$('#announcer');a.textContent='';setTimeout(()=>a.textContent=msg,30);}

/* ================= Icons ================= */
const IC={
home:'<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
content:'<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h6"/>',
commerce:'<path d="M5 8h14l-1 12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
trust:'<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
automation:'<rect x="5" y="7" width="14" height="12" rx="2"/><path d="M12 3v4M9.5 12h.01M14.5 12h.01M9 16h6M2 12h3M19 12h3"/>',
stats:'<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
network:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
settings:'<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
ops:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
approve:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>',
bell:'<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01"/>',
menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
x:'<path d="M6 6l12 12M18 6 6 18"/>',
chevR:'<path d="m9 18 6-6-6-6"/>',chevL:'<path d="m15 18-6-6 6-6"/>',chevD:'<path d="m6 9 6 6 6-6"/>',
lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
check:'<path d="m5 12 5 5 9-10"/>',minus:'<path d="M7 12h10"/>',
up:'<path d="M12 19V5M6 11l6-6 6 6"/>',down:'<path d="M12 5v14M6 13l6 6 6-6"/>',
side:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
play:'<path d="M7 5v14l12-7z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
power:'<path d="M12 3v9"/><path d="M6.3 7.5a8 8 0 1 0 11.4 0"/>',
alert:'<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
dollar:'<path d="M12 3v18M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H6"/>',
user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
life:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
moon:'<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
cols:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
download:'<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',plus:'<path d="M12 5v14M5 12h14"/>',
ext:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
sort:'<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
kbd:'<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
logout:'<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4"/>',
back:'<path d="M19 12H5M11 6l-6 6 6 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
spark:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
flag:'<path d="M5 21V4h11l-2 4 2 4H5"/>',
globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'
};
const ic=(n,c)=>`<svg class="i ${c||''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${IC[n]||''}</svg>`;
const MARK='<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="0" y="54" width="46" height="46" rx="5" fill="var(--brand)"/><rect x="54" y="54" width="46" height="46" rx="5" fill="var(--brand)"/><rect x="54" y="0" width="46" height="46" rx="5" fill="var(--brand)"/></svg>';

/* ================= Synthetic data (clearly invented) ================= */
const ME='Synthetic Owner A';
const STAFF=[
 {id:'s1',name:'Synthetic Owner A',roles:['r_owner'],scope:'hub',mfa:true,ends:null,status:'st_active'},
 {id:'s2',name:'Synthetic Commercial B',roles:['r_comm'],scope:'hub',mfa:true,ends:NOW+60*D,status:'st_active'},
 {id:'s3',name:'Synthetic Support C',roles:['r_supLead'],scope:'hub',mfa:true,ends:null,status:'st_active'},
 {id:'s4',name:'Synthetic Support D',roles:['r_supAgent'],scope:'hub',mfa:true,ends:NOW+20*D,status:'st_active'},
 {id:'s5',name:'Synthetic Moderator E',roles:['r_mod'],scope:'hub',mfa:true,ends:null,status:'st_active'},
 {id:'s6',name:'Synthetic Compliance F',roles:['r_comp'],scope:'node',mfa:true,ends:null,status:'st_active'},
 {id:'s7',name:'Synthetic Auditor G',roles:['r_aud'],scope:'node',mfa:true,ends:NOW+90*D,status:'st_active'},
 {id:'s8',name:'Synthetic Editor H',roles:['r_editor'],scope:'hub',mfa:false,ends:null,status:'st_invited'}
];
const FIRST=['Alex','Maria','Jordan','Sam','Priya','Diego','Lena','Omar','Grace','Tomas','Nina','Ray','Ivy','Malik','Rosa','Ken'];
const LAST=['Example','Sample','Placeholder','Demo','Testcase','Fixture'];
const COS=['Example Roofing LLC','Sample Electric Co.','Demo Builders Inc.','Placeholder Plumbing LLC','Fixture Lumber Co.','Testcase Concrete Inc.','Example Solar LLC','Sample Supply Co.'];
const COUNTIES=['San Diego','Imperial','Riverside','Orange'];
const TRADES=['tr_gc','tr_elec','tr_plumb','tr_roof','tr_arch','tr_client'];
const PEOPLE=[];
for(let i=0;i<30;i++){const co=i%4===3;const name=co?COS[(i>>2)%COS.length]:FIRST[i%FIRST.length]+' '+LAST[i%LAST.length];
 const ver=co?(['v_sourced','v_claimed','v_verified'][i%3]):(['v_verified','v_unverified','v_verified','v_verified','v_unverified'][i%5]);
 PEOPLE.push({id:'p'+i,name,type:co?'company':'person',trade:co?(i%8===3?'tr_supp':'tr_gc'):TRADES[i%TRADES.length],county:COUNTIES[i%7===0?1:i%5===0?2:i%9===0?3:0],ver,joined:NOW-(i*11+3)*D,status:i===7||i===19?'st_restricted':'st_active',conf:co?(i*3)%17:(i*5)%23,proj:(i*7)%6});}
PEOPLE[0].name='Alex Example';
const CASES=[
 {id:'C-1042',get subject(){return t('fx_case1')},pid:'p0',status:'cs_open',opened:NOW-5*H,assignee:'Synthetic Support C'},
 {id:'C-1043',get subject(){return t('fx_case2')},pid:'p3',status:'cs_waiting',opened:NOW-26*H,assignee:'Synthetic Support D'},
 {id:'C-1044',get subject(){return t('fx_case3')},pid:'p8',status:'cs_open',opened:NOW-3*H,assignee:'Synthetic Support D'},
 {id:'C-1045',get subject(){return t('fx_case4')},pid:'p0',status:'cs_open',opened:NOW-50*M,assignee:'—'},
 {id:'C-1031',get subject(){return t('fx_case5')},pid:'p0',status:'cs_closed',opened:NOW-9*D,assignee:'Synthetic Support C'}
];
const ACCESSLOG=[
 {at:NOW-4*H,staff:'Synthetic Support C',action:'la_lookup',cs:'C-1042'},
 {at:NOW-4*H+3*M,staff:'Synthetic Support C',action:'la_view',cs:'C-1042'},
 {at:NOW-9*D,staff:'Synthetic Support C',action:'la_grant',cs:'C-1031'}
];
const AGENTS=[
 {id:'a1',name:'Triage-1',role:'ar_triage',area:'area_support',task:'task_triage',aut:'au_draft',acc:'Synthetic Support C',cap:12,spent:4.1,state:'st_active'},
 {id:'a2',name:'Writer-1',role:'ar_writer',area:'area_editorial',task:'task_draft',aut:'au_review',acc:'Synthetic Editor H',cap:20,spent:11.6,state:'st_active'},
 {id:'a3',name:'Writer-2',role:'ar_writer',area:'area_editorial',task:'task_draft',aut:'au_review',acc:'Synthetic Editor H',cap:20,spent:17.9,state:'st_active'},
 {id:'a4',name:'Fact-1',role:'ar_fact',area:'area_editorial',task:'task_check',aut:'au_draft',acc:'Synthetic Editor H',cap:15,spent:6.2,state:'st_active'},
 {id:'a5',name:'Translate-ES',role:'ar_transl',area:'area_editorial',task:'task_transl',aut:'au_review',acc:'Synthetic Editor H',cap:18,spent:9.4,state:'st_active'},
 {id:'a6',name:'Scout-1',role:'ar_scout',area:'area_editorial',task:'task_scout',aut:'au_observe',acc:'Synthetic Compliance F',cap:8,spent:2.0,state:'st_paused'},
 {id:'a7',name:'Layout-1',role:'ar_layout',area:'area_editorial',task:'task_layout',aut:'au_draft',acc:'Synthetic Editor H',cap:10,spent:1.1,state:'st_active'},
 {id:'a8',name:'Ops-1',role:'ar_ops',area:'area_ops',task:'task_ops',aut:'au_limits',acc:'Synthetic Owner A',cap:6,spent:3.3,state:'st_active'}
];
const CONTENT=[
 {id:'e1',get title(){return t('fx_content1')},fmt:'fm_news',langs:['EN','ES'],stage:'cq_review',who:'a2',due:NOW+6*H,self:false},
 {id:'e2',get title(){return t('fx_content2')},fmt:'fm_guide',langs:['EN'],stage:'cq_fact',who:'a4',due:NOW+26*H,self:false},
 {id:'e3',get title(){return t('fx_content3')},fmt:'fm_event',langs:['EN','ES'],stage:'sg_scheduled',who:'Synthetic Editor H',due:NOW+3*D,self:false},
 {id:'e4',get title(){return t('fx_content4')},fmt:'fm_correction',langs:['EN','ES'],stage:'s_legal',who:'Synthetic Editor H',due:NOW+2*H,self:false},
 {id:'e5',get title(){return t('fx_content5')},fmt:'fm_news',langs:['EN'],stage:'sg_drafting',who:'a3',due:NOW+30*H,self:false},
 {id:'e6',get title(){return t('fx_content6')},fmt:'fm_guide',langs:['EN','ES'],stage:'cq_review',who:ME,due:NOW+10*H,self:true},
 {id:'e7',get title(){return t('fx_content7')},fmt:'fm_guide',langs:['EN'],stage:'sg_intake',who:'a6',due:NOW+4*D,self:false},
 {id:'e8',get title(){return t('fx_content8')},fmt:'fm_news',langs:['EN'],stage:'sg_published',who:'a2',due:NOW-D,self:false},
 {id:'e9',get title(){return t('fx_content9')},fmt:'fm_news',langs:['EN','ES'],stage:'cq_review',who:'a2',due:NOW+20*H,self:false},
 {id:'e10',get title(){return t('fx_content10')},fmt:'fm_guide',langs:['EN'],stage:'cq_fact',who:'a4',due:NOW+2*D,self:false},
 {id:'e11',get title(){return t('fx_content11')},fmt:'fm_news',langs:['EN','ES'],stage:'sg_returned',who:'a3',due:NOW+12*H,self:false}
];
const MODELS=[
 {id:'m1',name:'example-large-2',provider:'Example Models Inc.',ev:'eval_pass',cin:3.0,cout:15.0,route:'route_primary',status:'st_active'},
 {id:'m2',name:'example-small-2',provider:'Example Models Inc.',ev:'eval_pass',cin:0.25,cout:1.25,route:'route_fallback',status:'st_active'},
 {id:'m3',name:'sample-translate-1',provider:'Sample AI LLC',ev:'eval_pass',cin:0.8,cout:2.4,route:'route_primary',status:'st_active'},
 {id:'m4',name:'fixture-open-7b',provider:'Self-hosted',ev:'eval_fail',cin:0.05,cout:0.05,route:'route_none',status:'st_paused'}
];
const PRICES=[
 {id:'c1',cap:'cap_drafting',unit:'unit_req',cost:0.31,price:0.40,v:4,status:'st_current'},
 {id:'c2',cap:'cap_translation',unit:'unit_words',cost:0.62,price:0.90,v:2,status:'st_current'},
 {id:'c3',cap:'cap_search',unit:'unit_req',cost:0.04,price:0.03,v:3,status:'st_current'},
 {id:'c4',cap:'cap_plan',unit:'unit_plan',cost:1.10,price:2.50,v:1,status:'st_current'}
];
const MODE_VERSIONS=[
 {v:7,by:'Synthetic Owner A',ap:'Synthetic Compliance F',at:NOW-6*D,status:'st_current'},
 {v:6,by:'Synthetic Compliance F',ap:'Synthetic Owner A',at:NOW-21*D,status:'st_superseded'},
 {v:5,by:'Synthetic Owner A',ap:'Synthetic Commercial B',at:NOW-40*D,status:'st_superseded'}
];
const S={
 theme:'system',density:'comfortable',collapsed:false,singleKey:true,live:true,
 route:{sec:'home',item:'overview',param:null},
 tables:{},tabs:{},
 approvals:[
  {id:'AP-311',title:['ap_price',{v:5,cap:'@cap_drafting'}],by:'Synthetic Commercial B',at:NOW-2*H,exp:NOW+22*H,get reason(){return t('fx_reason1')},diff:[['f_price',()=>fUSD(0.40),()=>fUSD(0.45)],['f_effective',()=>fDate(Date.UTC(2026,10,15,12)),()=>fDate(Date.UTC(2026,11,1,12))]],status:'pending'},
  {id:'AP-312',title:['ap_access',{name:'Alex Example'}],by:'Synthetic Support D',at:NOW-40*M,exp:NOW+70*H,get reason(){return t('fx_reason2')},diff:[['ra_scope','—','@ra_security'],['ra_duration','—',()=>unit(24,'hour')]],status:'pending'},
  {id:'AP-313',title:['ap_role',{name:'Synthetic Editor H'}],by:'Synthetic Support C',at:NOW-5*H,exp:NOW+43*H,get reason(){return t('fx_reason3')},diff:[['c_role','—','@r_editor'],['c_ends','—',()=>fDate(Date.UTC(2026,11,31,12))]],status:'pending'},
  {id:'AP-310',title:['ap_settings',{what:'@f_indexing'}],by:ME,at:NOW-3*H,exp:NOW+45*H,get reason(){return t('fx_reason4')},diff:[['f_indexing','@off','@on']],status:'pending'},
  {id:'AP-305',title:['ap_price',{v:2,cap:'@cap_translation'}],by:'Synthetic Commercial B',at:NOW-2*D,exp:NOW-D,get reason(){return t('fx_reason5')},diff:[['f_price',()=>fUSD(0.95),()=>fUSD(0.90)]],status:'approved',decided:NOW-D-3*H}
 ],
 modes:{registration:'reg_invite',moderation:'mod_pre',indexing:false,maintenance:false},
 draft:null,modesPending:null,
 kill:{ks_dispatch:{on:false,by:null,at:null,rel:false},ks_outbound:{on:false,by:null,at:null,rel:false},ks_external:{on:false,by:null,at:null,rel:false}},
 grant:null,
 runs:[],feed:[],perMin:Array.from({length:30},(_,i)=>Math.round(3+3*Math.sin(i/3)+R()*3)),
 spend:61.6,spendCap:150,payments:18420,cases:12,okToday:86,failToday:3,reviewToday:9,
 notifications:[{id:'n1',title:['ap_price',{v:2,cap:'@cap_translation'}],state:'st_approved',at:NOW-D-3*H,read:false},{id:'n2',title:['ap_settings',{what:'@f_registration'}],state:'st_approved',at:NOW-6*D,read:true}],
 incTimeline:[{at:NOW-47*M,k:'tl_detected',cls:'warn',who:'Ops-1'},{at:NOW-44*M,k:'tl_opened',cls:'info',who:ME}],
 arrived:0,drawer:null
};
// seed runs
(function(){let n=4810;const tasks=AGENTS.filter(a=>a.state==='st_active');for(let i=0;i<14;i++){const a=tasks[i%tasks.length];const st=NOW-(i*95+20)*1000;const done=i>3;S.runs.push({id:'R-'+(n-i),agent:a.id,start:st,end:done?st+(30+i*7)*1000:null,status:done?(i%9===5?'run_fail':i%6===2?'run_review':'run_ok'):'run_running',cost:+(0.02+((i*37)%50)/100).toFixed(2),dur:40+(i*13)%70});}
 const ev=[['ev_runOk',{agent:'Writer-1',task:'@task_draft'},'ok','spark',NOW-90*1000],['ev_case',{id:'C-1045'},'info','life',NOW-50*M],['ev_payment',{amount:fUSD(1250)},'neu','dollar',NOW-62*M],['ev_approval',{title:'AP-312'},'warn','approve',NOW-40*M],['ev_runReview',{agent:'Translate-ES',task:'@task_transl'},'ai','spark',NOW-3*M]];
 ev.sort((a,b)=>b[4]-a[4]).forEach(e=>S.feed.push({k:e[0],v:e[1],cls:e[2],icon:e[3],at:e[4],id:nid('f')}));})();
try{const p=JSON.parse(localStorage.getItem('tw2-prefs')||'{}');Object.assign(S,{theme:p.theme||S.theme,density:p.density||S.density,collapsed:!!p.collapsed,singleKey:p.singleKey!==false});}catch(e){}
function savePrefs(){try{localStorage.setItem('tw2-prefs',JSON.stringify({theme:S.theme,density:S.density,collapsed:S.collapsed,singleKey:S.singleKey}));localStorage.setItem('tw2-lang',String(li));}catch(e){}}
const waitingForMe=()=>S.approvals.filter(a=>a.status==='pending'&&a.by!==ME);
const runningRuns=()=>S.runs.filter(r=>r.status==='run_running');
const agentById=id=>AGENTS.find(a=>a.id===id);
const personById=id=>PEOPLE.find(p=>p.id===id);

/* ================= Navigation map ================= */
const DOCS={users:'docs/engine/hub-console/console-design.md',content:'docs/engine/editorial-office.md',commerce:'docs/engine/hub-console/screens.md',trust:'docs/engine/hub-console/screens.md',automation:'docs/engine/hub-console/automation-and-scheduling.md',stats:'docs/engine/hub-console/console-design.md',network:'docs/engine/hub-network.md',settings:'docs/engine/hub-console/screens.md',ops:'docs/engine/hub-console/operations.md',home:'docs/engine/hub-console/screens.md'};
const NAV=[
 {id:'home',icon:'home',label:'n_home',items:[['overview','s_overview'],['approvals','approvals']]},
 {id:'users',icon:'users',label:'n_users',items:[['people','s_people'],['companies','s_companies'],['support','s_support'],['staff','s_staff'],['clients','s_clients']]},
 {id:'content',icon:'content',label:'n_content',items:[['queue','s_queue'],['publications','s_publications'],['calendar','s_calendar'],['translations','s_translations'],['sources','s_sources'],['data','s_data'],['media','s_media'],['channels','s_channels'],['outreach','s_outreach'],['policy','s_policy']]},
 {id:'commerce',icon:'commerce',label:'n_commerce',items:[['plans','s_plans'],['prices','s_prices'],['invoices','s_invoices'],['payouts','s_payouts'],['credits','s_credits'],['tax','s_tax'],['marketplace','s_marketplace'],['procurement','s_procurement']]},
 {id:'trust',icon:'trust',label:'n_trust',items:[['verification','s_verification'],['moderation','s_moderation'],['screening','s_screening'],['privacy','s_privacy'],['methods','s_repMethods']]},
 {id:'automation',icon:'automation',label:'n_automation',items:[['runs','s_runs'],['team','s_agentTeam'],['schedules','s_schedules'],['alerts','s_alerts'],['models','s_models'],['kill','s_kill']]},
 {id:'stats',icon:'stats',label:'n_stats',items:[['dashboards','s_dashboards'],['metrics','s_metrics'],['segments','s_segments'],['reports','s_reports'],['access','s_statsAccess']]},
 {id:'network',icon:'network',label:'n_network',items:[['directory','s_directory'],['peers','s_peers'],['channel','s_channel'],['licences','s_licences'],['deletions','s_deletions'],['incoming','s_incoming']]},
 {id:'settings',icon:'settings',label:'n_settings',items:[['general','s_general'],['modes','s_modes'],['modules','s_modules'],['agents','s_agentProduct'],['legal','s_legal'],['residency','s_residency'],['country','s_country'],['taxonomy','s_taxonomy'],['launch','s_launch'],['comms','s_comms']]},
 {id:'ops',icon:'ops',label:'n_ops',items:[['health','s_health'],['incidents','s_incidents'],['jobs','s_jobs'],['flags','s_flags'],['maintenance','s_maintenance'],['audit','s_audit'],['locales','s_locales'],['a11y','s_a11y']]}
];
const BUILT=new Set(['home/overview','home/approvals','users/people','users/companies','users/support','users/staff','content/queue','automation/runs','automation/team','automation/models','automation/kill','settings/modes','ops/incidents','stats/dashboards']);
function navCount(sec,item){if(sec==='home'&&item==='approvals')return waitingForMe().length;if(sec==='users'&&item==='support')return S.cases;if(sec==='content'&&item==='queue')return CONTENT.filter(c=>c.stage==='cq_review').length;if(sec==='automation'&&item==='runs')return runningRuns().length;if(sec==='ops'&&item==='incidents')return 1;return 0;}
const secById=id=>NAV.find(s=>s.id===id);
const href=(sec,item,param)=>'#/'+sec+'/'+item+(param?'/'+param:'');

/* ================= Generic components ================= */
function hint(text,label,end){const id=nid('tip');return `<span class="hint${end?' end':''}"><button type="button" aria-label="${esc(label||t('moreInfo'))}" aria-describedby="${id}" data-act="hint">?</button><span class="tip" role="tooltip" id="${id}">${esc(text)}</span></span>`;}
function lockBadge(nameKey,tipKey){const id=nid('tip');return `<span class="hint"><button type="button" class="b lock outline" aria-describedby="${id}" data-act="hint">${ic('lock','sm')} ${esc(t(nameKey))}</button><span class="tip" role="tooltip" id="${id}">${esc(t(tipKey))}</span></span>`;}
const TONE={st_active:'ok',v_verified:'ok',st_current:'ok',eval_pass:'ok',run_ok:'ok',st_healthy:'ok',st_approved:'ok',inc_resolved:'ok',cs_closed:'neu',route_primary:'info',
 v_unverified:'warn',st_pending:'warn',cq_review:'warn',run_review:'warn',st_paused:'warn',st_degraded:'warn',inc_mitigated:'warn',cs_waiting:'warn',sg_returned:'warn',st_invited:'info',route_fallback:'neu',
 st_restricted:'bad',eval_fail:'bad',run_fail:'bad',st_stopped:'bad',st_down:'bad',st_declined:'bad',inc_investigating:'bad',run_unknown:'bad',run_stopped:'neu',
 v_sourced:'neu',v_claimed:'info',run_running:'info run',cs_open:'info',sg_published:'ok',sg_scheduled:'info',cq_fact:'info',s_legal:'info',sg_drafting:'neu',sg_intake:'neu',st_superseded:'neu',st_withdrawn:'neu',route_none:'neu',engaged:'bad',released:'ok'};
const badge=(k,extra)=>`<span class="b ${TONE[k]||''} ${extra||''}">${esc(t(k))}</span>`;
function crumbs(list){return `<nav aria-label="${esc(t('fx_breadcrumb'))}" class="crumbs">${list.map((c,i)=>(i?'<span class="sep" aria-hidden="true">/</span>':'')+(c[1]?`<a href="${c[1]}">${esc(c[0])}</a>`:`<span aria-current="page">${esc(c[0])}</span>`)).join('')}</nav>`;}
function pageHead(o){const sec=secById(S.route.sec);const base=[[t('hubName'),href('home','overview')]];if(sec&&S.route.sec!=='home')base.push([t(sec.label),href(sec.id,sec.items[0][0])]);return crumbs(base.concat(o.crumbs||[]))+`<div class="ph"><h1 tabindex="-1" id="pageTitle">${esc(o.title)}</h1>${o.badge||''}${o.acts?`<div class="acts">${o.acts}</div>`:''}</div>`;}
function tabsHtml(id,items,active){return `<div class="tabs" role="tablist" data-tabs="${id}">${items.map(([v,l,c])=>`<button role="tab" type="button" class="tab" id="tab-${id}-${v}" aria-selected="${v===active}" tabindex="${v===active?0:-1}" data-act="tab" data-tabs="${id}" data-v="${v}">${esc(l)}${c!=null?`<span class="cnt">${fN(c)}</span>`:''}</button>`).join('')}<span class="ind" aria-hidden="true"></span></div>`;}
const curTab=(id,def)=>S.tabs[id]||def;
function emptyState(icon,title,action){return `<div class="empty"><div class="ico">${ic(icon)}</div><strong>${esc(title)}</strong>${action||''}</div>`;}
function meter(v,cap){const p=Math.min(100,Math.round(v/cap*100));return `<div class="meter ${p>=90?'bad':p>=75?'warn':''}" aria-hidden="true"><span style="width:${p}%"></span></div>`;}
function kv(rows){return `<dl class="kv">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;}
const tv=v=>typeof v==='function'?v():typeof v==='string'&&v[0]==='@'?t(v.slice(1)):v;
function diffTable(diff){return `<table class="diff"><thead><tr><th scope="col">${esc(t('c_field'))}</th><th scope="col">${esc(t('c_before'))}</th><th scope="col">${esc(t('c_after'))}</th></tr></thead><tbody>${diff.map(([f,o,n])=>`<tr><th scope="row" style="font-weight:500;color:var(--text)">${esc(t(f))}</th><td>${o==='—'?'—':`<span class="o">${esc(tv(o))}</span>`}</td><td><span class="a">${esc(tv(n))}</span></td></tr>`).join('')}</tbody></table>`;}


/* ---------- DataTable ---------- */
function TS(id){return S.tables[id]||(S.tables[id]={q:'',f:{},sort:{key:null,dir:1},page:0,sel:new Set(),hidden:new Set(),view:null});}
function dataTable(o){
 const st=TS(o.id);let rows=o.rows;
 if(o.views&&st.view){const v=o.views.find(v=>v[0]===st.view);if(v)rows=rows.filter(v[2]);}
 if(st.q){const q=st.q.toLowerCase();rows=rows.filter(r=>o.text(r).toLowerCase().includes(q));}
 for(const f of o.filters||[])if(st.f[f.key])rows=rows.filter(r=>f.get(r)===st.f[f.key]);
 if(st.sort.key){const c=o.cols.find(c=>c.key===st.sort.key);rows=[...rows].sort((a,b)=>{const x=c.sv(a),y=c.sv(b);return(x>y?1:x<y?-1:0)*st.sort.dir;});}
 const ps=o.pageSize||10,total=rows.length,pages=Math.max(1,Math.ceil(total/ps));if(st.page>=pages)st.page=pages-1;
 const slice=rows.slice(st.page*ps,st.page*ps+ps);
 const cols=o.cols.filter(c=>!st.hidden.has(c.key));
 const activeChips=(o.filters||[]).filter(f=>st.f[f.key]).map(f=>{const opt=f.opts.find(x=>x[0]===st.f[f.key]);const lab=t(f.label)+': '+tv(opt[1]);return `<span class="chip">${esc(lab)}<button type="button" aria-label="${esc(t('removeFilter',{f:lab}))}" data-act="fclear" data-t="${o.id}" data-k="${f.key}">${ic('x','sm')}</button></span>`;}).join('');
 const fsel=(o.filters||[]).filter(f=>!st.f[f.key]).map(f=>`<label class="vh" for="f-${o.id}-${f.key}">${esc(t(f.label))}</label><select class="fsel" id="f-${o.id}-${f.key}" data-in="filter" data-t="${o.id}" data-k="${f.key}"><option value="">${esc(t(f.label))}</option>${f.opts.map(x=>`<option value="${esc(x[0])}">${esc(tv(x[1]))}</option>`).join('')}</select>`).join('');
 const anyFilter=st.q||Object.values(st.f).some(Boolean);
 let h=`<div class="card" id="dt-${o.id}">`;
 if(o.views)h+=`<div class="fbar" style="border-bottom:0;padding-bottom:0"><div class="views" role="group" aria-label="${esc(t('views'))}">${[[null,t('all')],...o.views.map(v=>[v[0],t(v[1])])].map(([v,l])=>`<button type="button" aria-pressed="${st.view===v}" data-act="view" data-t="${o.id}" data-v="${v||''}" id="vw-${o.id}-${v||'all'}">${esc(l)}</button>`).join('')}</div></div>`;
 h+=`<div class="fbar">`;
 if(o.text)h+=`<div class="search">${ic('search','sm')}<label class="vh" for="q-${o.id}">${esc(t('searchLbl'))}</label><input class="inp" type="search" id="q-${o.id}" data-filter data-in="q" data-t="${o.id}" value="${esc(st.q)}" placeholder="${esc(t('searchLbl'))}" autocomplete="off"></div>`;
 h+=fsel+activeChips+(anyFilter?`<button type="button" class="linkbtn" data-act="fclearall" data-t="${o.id}" id="fca-${o.id}">${esc(t('clearAll'))}</button>`:'');
 h+=`<span class="grow"></span>`+(o.tools||'');
 if(o.cols.some(c=>c.hide))h+=`<button type="button" class="btn sm ghost" data-act="colmenu" aria-label="${esc(t('columns'))}" data-t="${o.id}" aria-haspopup="true" aria-expanded="false" id="cm-${o.id}">${ic('cols','sm')}<span class="hide-sm">${esc(t('columns'))}</span></button>`;
 h+=`</div>`;
 if(o.select&&st.sel.size)h+=`<div class="bulk" role="region" aria-label="${esc(t('selected',{n:st.sel.size}))}"><strong>${esc(t('selected',{n:fN(st.sel.size)}))}</strong><span class="grow"></span>${o.bulk.map(([a,l,icn])=>`<button type="button" class="btn sm" data-act="bulk" data-t="${o.id}" data-b="${a}" id="bk-${o.id}-${a}">${ic(icn,'sm')}${esc(t(l))}</button>`).join('')}<button type="button" class="btn sm ghost" data-act="selnone" data-t="${o.id}" id="bkx-${o.id}">${esc(t('cancel'))}</button></div>`;
 if(!total)return h+emptyState('search',t('noResults'),anyFilter?`<button type="button" class="btn sm" data-act="fclearall" data-t="${o.id}" id="fcb-${o.id}">${esc(t('clearFilters'))}</button>`:'')+'</div>';
 const allSel=slice.length&&slice.every(r=>st.sel.has(r.id));
 h+=`<div class="tblwrap"><table class="dt" aria-labelledby="pageTitle"><thead><tr>`;
 if(o.select)h+=`<th class="c" scope="col"><input type="checkbox" class="cb" data-act="selall" data-t="${o.id}" id="sa-${o.id}" aria-label="${esc(t('selectAll'))}" ${allSel?'checked':''}></th>`;
 for(const c of cols){const sorted=st.sort.key===c.key;h+=`<th scope="col" class="${c.cls||''}" ${sorted?`aria-sort="${st.sort.dir>0?'ascending':'descending'}"`:''}>${c.sv?`<button type="button" data-act="sort" data-t="${o.id}" data-k="${c.key}" id="so-${o.id}-${c.key}">${esc(t(c.label))}${ic(sorted?(st.sort.dir>0?'up':'down'):'sort','sm')}</button>`:esc(t(c.label))}</th>`;}
 h+=`</tr></thead><tbody>`;
 for(const r of slice){const sel=st.sel.has(r.id);h+=`<tr class="${o.row?'click':''} ${r._new?'new':''}" ${o.select?`aria-selected="${sel}"`:''} ${o.row?`data-act="row" data-t="${o.id}" data-id="${r.id}"`:''} id="tr-${o.id}-${r.id}">`;
  if(o.select)h+=`<td class="c"><input type="checkbox" class="cb" data-act="sel" data-t="${o.id}" data-id="${r.id}" id="cb-${o.id}-${r.id}" aria-label="${esc(t('selectRow',{name:o.name(r)}))}" ${sel?'checked':''}></td>`;
  for(const c of cols)h+=`<td class="${c.cls||''}" data-label="${esc(t(c.label))}" ${c.cellId?`id="${c.cellId(r)}"`:''}>${c.r(r)}</td>`;
  h+=`</tr>`;r._new=false;}
 h+=`</tbody></table></div>`;
 if(total>ps||o.alwaysPager)h+=`<div class="pager"><span>${esc(t('rangeOf',{a:fN(st.page*ps+1),b:fN(Math.min(total,st.page*ps+ps)),n:fN(total)}))}</span><span class="row"><button type="button" class="iconbtn" data-act="page" data-t="${o.id}" data-d="-1" id="pg-${o.id}-p" aria-label="${esc(t('prev'))}" ${st.page===0?'disabled':''}>${ic('chevL')}</button><button type="button" class="iconbtn" data-act="page" data-t="${o.id}" data-d="1" id="pg-${o.id}-n" aria-label="${esc(t('next'))}" ${st.page>=pages-1?'disabled':''}>${ic('chevR')}</button></span></div>`;
 return h+'</div>';
}
const rowBtn=(tid,id,label,lang)=>`<button type="button" class="linkbtn pri rowbtn" data-act="row" data-t="${tid}" data-id="${id}" id="rb-${tid}-${id}" ${lang?`lang="${lang}"`:''} style="color:var(--text);text-align:left">${esc(label)}</button>`;
