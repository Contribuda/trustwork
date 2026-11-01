import re
s=open('orig/network-prototype.html').read()
def rep(old,new,count=1):
    global s
    n=s.count(old)
    assert n>=1, ('missing',old[:80])
    if count==1: assert n==1, ('ambiguous',n,old[:80])
    s=s.replace(old,new)
# head
rep('--focus:#ffbf00;--radius:8px}','--focus:#ffbf00;--radius:8px;--lp-bg:var(--surface);--lp-ink:var(--ink);--lp-line:var(--line);--lp-accent:var(--blue)}')
rep('</style>','/*@@KIT_CSS@@*/\n.proto-bar .lp-btn{border-color:#556}\n</style>')
rep('<div class="proto-bar" role="region" aria-label="Prototype controls">','<div class="proto-bar" role="region" data-i18n-label="protoControls">')
rep('<span class="seg" role="group" aria-label="Language"><button type="button" data-lang="en" aria-pressed="true">English</button><button type="button" data-lang="ru" aria-pressed="false" lang="ru">Русский</button></span>','<span id="langPicker"></span>')
rep('<span class="seg" role="group" aria-label="Viewport">','<span class="seg" role="group" data-i18n-label="viewport">')
# i18n table
a=s.index('const I18N = {'); b=s.index('let LANG="en";')
s=s[:a]+'/*@@KIT_JS@@*/\n/*@@MESSAGES@@*/\n'+s[b:]
rep('let LANG="en";\nfunction t(k,vars){let s=(I18N[LANG][k]!==undefined?I18N[LANG][k]:I18N.en[k]);if(s===undefined)return k;if(vars)for(const [a,b] of Object.entries(vars))s=s.split("{"+a+"}").join(b);return s;}',
    'const t=L10N.t, tp=L10N.tp;')
rep('const fmtDate=d=>new Intl.DateTimeFormat(LANG==="ru"?"ru-RU":"en-US",{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(d));',
    'const fmtDate=d=>L10N.date(d,{dateStyle:"medium",timeZone:"UTC"});')
rep('const fmtNum=n=>new Intl.NumberFormat(LANG==="ru"?"ru-RU":"en-US").format(n);','const fmtNum=n=>L10N.num(n);\nconst range=(a,b)=>fmtNum(a)+"–"+fmtNum(b);')
rep('const langName=c=>{try{return new Intl.DisplayNames([LANG==="ru"?"ru":"en"],{type:"language"}).of(c)}catch(e){return c}};',
    '/* Language names come from MESSAGES: browsers lack display names for several engine languages. */\nconst langName=c=>t("langNames."+c);\nconst viaText=v=>v==="tw"?t("dirTrustwork"):v;\nconst tombText=h=>h.tomb==null?"-":t("hours",{n:fmtNum(h.tomb)});')
# data
s=re.sub(r'tomb:"(\d+) h"',r'tomb:\1',s)
rep('tomb:"-"','tomb:null',count=2)
rep('stricter:["person profiles"]','stricter:["persons"]',count=2)
rep('stricter:["member publications"]','stricter:["member"]')
rep('via:"Trustwork hub directory"','via:"tw"',count=2)
rep('role:"Ops engineer, Example Bajío Construye",fields:[["fCategory","availability"],["fStatusF","investigating"],["fImpact","feeds delayed up to 2 h"]],body:"Our object storage provider has a regional outage. Feeds and inbox keep working; images in replicas may fail to load. Next update in 2 hours."',
    'role:{k:"ops",hub:"bajio"},fields:[["fCategory",{k:"fv.availability"}],["fStatusF",{k:"fv.investigating"}],["fImpact",{k:"fv.delayed"}]],bodyKey:"t1a"')
rep('role:"Compliance officer, Trustwork San Diego (demo)",fields:[],body:"Thanks. We paused image checks for your replicas until you report recovery."',
    'role:{k:"compliance",hub:"sd"},fields:[],bodyKey:"t1b"')
rep('role:"Moderator, Trustwork San Diego (demo)",fields:[["target","trustwork://tbilisi.example.invalid/open_need/n-88"],["clause","spam.repeated_posting"]],body:"The same open need has been republished 14 times this week with new identifiers. Could you review it under your rules?"',
    'role:{k:"moderator",hub:"sd"},fields:[["target","trustwork://tbilisi.example.invalid/open_need/n-88"],["clause","spam.repeated_posting"]],bodyKey:"t2a"')
rep('role:"Hub owner, Example Lisboa Obra",fields:[["fReqLevel","syndicate"],["fProposed","events, editorial publications, directory facts"]],body:"We would like to share our event calendar and editorial articles with your readers."',
    'role:{k:"owner",hub:"lisbon"},fields:[["fReqLevel",{k:"lvl_syndicate"}],["fProposed",{k:"fv.proposedSet"}]],bodyKey:"t3a"')
a=s.index('const ANN=['); b=s.index('];',a)+2
s=s[:a]+'''const ANN=[
 {id:"a1",pub:"project",sev:"security",when:"2026-10-30"},
 {id:"a2",pub:"dir",dir:"tw",when:"2026-10-28"},
 {id:"a3",pub:"peer",hub:"austin",when:"2026-10-20",retracted:true}
];'''+s[b:]
rep('S.activity=[{d:"2026-10-02",k:"act1"},','S.activity=[{d:"2026-10-02",k:"act1"},')
# map markers and legend
rep('const lvl={syndicate:"S",trust_verifications:"T",deal_routing:"D",identity:"I"};\n','')
rep('${lvl[h.level]}</text>','${esc(t("lvlAbbr."+h.level))}</text>')
rep('const label=t("cluster",{n:g.items.length})+": "','const label=tp("cluster",g.items.length)+": "')
rep('${t("stPeer")} (S, T, D, I)','${t("stPeer")} (${["syndicate","trust_verifications","deal_routing","identity"].map(l=>esc(t("lvlAbbr."+l))).join(", ")})')
rep('.sort((a,b)=>countryName(a).localeCompare(countryName(b)));','.sort((a,b)=>countryName(a).localeCompare(countryName(b),L10N.fmt()));')
# list + drawer
rep('<td>${attestText(h)}</td><td>${esc(h.via)}</td></tr>','<td>${attestText(h)}</td><td>${esc(viaText(h.via))}</td></tr>')
rep('const lic=h.stricter.length?t("stricterSome",{c:h.stricter.join(", ")}):t("allDefault");','const lic=h.stricter.length?t("stricterSome",{c:L10N.list(h.stricter.map(x=>t("sc."+x)))}):t("allDefault");')
rep('<dd>${esc(h.name.replace("Example ","Example Operator "))} LLC (synthetic)<span','<dd>${esc(h.name.replace("Example ","Example Operator "))} LLC (${esc(t("synthetic"))})<span')
rep('<dt>${t("cVia")}</dt><dd>${esc(h.via)}</dd></dl>','<dt>${t("cVia")}</dt><dd>${esc(viaText(h.via))}</dd></dl>')
# peers table
rep('<td>${h.tomb||"-"}</td>','<td>${tombText(h)}</td>')
# peer overview licences
rep('${[["editorial publications","CC BY 4.0"],["member publications","headline and link"],["directory facts","open data with attribution"],["person profiles","mesh-only redisplay"],["events","redisplay with attribution"],["reputation snapshots","redisplay unchanged"],["reviews","never"]].map(r=>`<tr><th scope="row">${r[0]}</th><td>${r[1]}</td></tr>`).join("")}',
    '${t("licRows").map(r=>`<tr><th scope="row">${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join("")}')
rep('<li><time datetime="${a.d}">${fmtDate(a.d)}</time>: ${esc(t(a.k,a.vars))}</li>','<li><time datetime="${a.d}">${fmtDate(a.d)}</time>: ${esc(t(a.k,a.vars&&{v:a.vars.v,how:t(a.vars.how)}))}</li>')
rep('function valText(k,v){if(typeof v==="boolean")return v?"On":"Off";','function valText(k,v){if(typeof v==="boolean")return v?t("valOn"):t("valOff");')
rep('function valLocal(k,v){if(typeof v==="boolean")return LANG==="ru"?(v?"Вкл.":"Выкл."):(v?"On":"Off");return valText(k,v);}','const valLocal=valText;')
rep('if(d.k==="receive.persons"&&d.b!=="off")return t("eff_persons_on");','if(d.k==="receive.persons"&&d.b!=="off")return t("eff_persons_on",{n:fmtNum(1200)});')
rep('const rows=[[t("tLag"),"2 min"],[t("tAccepted"),fmtNum(4812)],[t("tRejected"),"7 (federation.signature_invalid 2, federation.rate_limited 5)"],[t("tRate"),"5"],[t("tTombMed"),t("hours",{n:4})]];',
    'const rows=[[t("tLag"),t("minutes",{n:fmtNum(2)})],[t("tAccepted"),fmtNum(4812)],[t("tRejected"),fmtNum(7)+" (federation.signature_invalid 2, federation.rate_limited 5)"],[t("tRate"),fmtNum(5)],[t("tTombMed"),t("hours",{n:fmtNum(4)})]];')
# request flow
rep('<dd>Example Operator Bayern Bau GmbH (synthetic), ${countryName("DE")}</dd>','<dd>Example Operator Bayern Bau GmbH (${esc(t("synthetic"))}), ${countryName("DE")}</dd>')
rep('<dd>${t("stricterSome",{c:h.stricter.join(", ")})}</dd>','<dd>${t("stricterSome",{c:L10N.list(h.stricter.map(x=>t("sc."+x)))})}</dd>')
rep('<p>${t("setTrust")}: <b>${t("trust_new")}</b> · ${t("inboxLimit")}: 200 ${t("perHour")}','<p>${t("setTrust")}: <b>${t("trust_new")}</b> · ${t("inboxLimit")}: ${fmtNum(200)} ${t("perHour")}')
# messages
rep('<h2 class="vh">Threads</h2>','<h2 class="vh">${t("threads")}</h2>')
rep('<span>${m.dir==="out"?t("to")+": "+esc(h.name):t("from")+": "+esc(m.role)}</span>','<span>${m.dir==="out"?t("to")+": "+esc(h.name):t("from")+": "+esc(t("role."+m.role.k,{hub:hub(m.role.hub).name}))}</span>')
rep('${m.fields.map(([k,v])=>`<div><b>${t(k)}:</b> ${esc(v)}</div>`).join("")}','${m.fields.map(([k,v])=>`<div><b>${t(k)}:</b> ${esc(typeof v==="object"?t(v.k):v)}</div>`).join("")}')
rep('<p>${esc(m.body)}</p></li>','${m.bodyKey?`<p>${esc(t("msgBodies."+m.bodyKey))}</p>`:`<p lang="${m.lang||"und"}">${esc(m.body)}</p>`}</li>')
rep('<button class="btn primary" data-send-msg>${LANG==="ru"?"Отправить":"Send"}</button>','<button class="btn primary" data-send-msg>${t("sendShort")}</button>')
rep('msgs.push({dir:"out",when:new Date().toISOString(),role:"",fields:$("#mtarget").value?[["target",$("#mtarget").value]]:[],body:b});',
    'msgs.push({dir:"out",when:new Date().toISOString(),role:null,fields:$("#mtarget").value?[["target",$("#mtarget").value]]:[],body:b,lang:L10N.lang});')
# announcements
rep('const ver=a.pub==="project"?t("verifiedProject"):a.pub==="dir"?t("verifiedDir",{d:a.dir}):t("verifiedPeer",{h:hub(a.hub).name});',
    'const ver=a.pub==="project"?t("verifiedProject"):a.pub==="dir"?t("verifiedDir",{d:viaText(a.dir)}):t("verifiedPeer",{h:hub(a.hub).name});')
rep('>${esc(a.title)}</h2>','>${esc(t("ann."+a.id+".title"))}</h2>')
rep('<p>${esc(a.body)}</p>${a.retracted','<p>${esc(t("ann."+a.id+".body"))}</p>${a.retracted')
# stats
rep('const rows=[["participants","f_participants","1,000-9,999"],["companies","f_companies","100-999"],["pubs","f_pubs","100-999"],["events","f_events",t("fewer10")],["tomb","f_tomb",t("hours",{n:6})]];',
    'const rows=[["participants","f_participants",range(1000,9999)],["companies","f_companies",range(100,999)],["pubs","f_pubs",range(100,999)],["events","f_events",t("fewer10")],["tomb","f_tomb",t("hours",{n:fmtNum(6)})]];')
rep('<th>${LANG==="ru"?"Значение":"Value"}</th>','<th>${t("value")}</th>')
rep('<td>${["3 min","2 min","48 min","-"][i]}</td><td>${fmtNum([2210,4812,930,0][i])}</td><td>${[1,7,58,0][i]}</td><td>${h.tomb}</td>',
    '<td>${[3,2,48,null][i]==null?"-":t("minutes",{n:fmtNum([3,2,48][i])})}</td><td>${fmtNum([2210,4812,930,0][i])}</td><td>${fmtNum([1,7,58,0][i])}</td><td>${tombText(h)}</td>')
rep('<td>${ps.length}</td>','<td>${fmtNum(ps.length)}</td>')
# listing
rep('<th scope="row">Trustwork hub directory</th>','<th scope="row">${esc(t("dirTrustwork"))}</th>')
rep('S.peerVis==="count"?"4":','S.peerVis==="count"?fmtNum(4):')
rep('<dd>${S.pub.participants?"1,000-9,999":"-"}</dd>','<dd>${S.pub.participants?range(1000,9999):"-"}</dd>')
# render & events
rep(' document.documentElement.lang=LANG;\n document.querySelectorAll("[data-i18n]").forEach(el=>{el.textContent=t(el.dataset.i18n)});\n $("#brandName").textContent=LANG==="ru"?"Строй Репутация":"Trustwork";',
    ' document.title=t("docTitle");\n document.querySelectorAll("[data-i18n]").forEach(el=>{el.textContent=t(el.dataset.i18n)});\n document.querySelectorAll("[data-i18n-label]").forEach(el=>el.setAttribute("aria-label",t(el.dataset.i18nLabel)));\n $("#brandName").textContent=t("brand");')
rep(' if(d.lang){LANG=d.lang;document.querySelectorAll("[data-lang]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.lang===LANG));render();return;}\n','')
rep('vars:{v:S.settingsVersion,how:t("howProtective")}','vars:{v:S.settingsVersion,how:"howProtective"}')
rep('vars:{v:S.settingsVersion,how:t("howApproved")}','vars:{v:S.settingsVersion,how:"howApproved"}')
rep('toast(t("defedToast"))','toast(t("defedToast",{r:fmtNum(1834),d:fmtNum(3)}))')
rep('toast(LANG==="ru"?"Раздел «Эксплуатация» не входит в этот прототип.":"Operations is outside this prototype.")','toast(t("opsOutside"))')
rep('toast(LANG==="ru"?"Отправлено в каталог. Каталог сам проверит манифест и допуск.":"Submitted. The directory fetches the manifest and runs its own admission check.")','toast(t("submittedDir"))')
rep('(function init(){','L10N.mount(document.getElementById("langPicker"));\nL10N.onChange(()=>render());\n(function init(){')
assert 'LANG' not in s.replace('L10N.lang','').replace('langPicker','').replace('LANGUAGE',''), [m.start() for m in re.finditer('LANG',s)]
open('src/network.html','w').write(s)
print('ok')
