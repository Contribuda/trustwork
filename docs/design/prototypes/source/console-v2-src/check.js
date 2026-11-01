const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');
const m=src.match(/const T=\{[\s\S]*?\n\};/)[0];const T=eval('('+m.replace('const T=','').replace(/;$/,'')+')');
let bad=0;for(const[k,v] of Object.entries(T)){if(!Array.isArray(v)||v.length!==7||v.some(x=>typeof x!=='string'||!x.trim())){console.log('BAD',k,v&&v.length);bad++;}
 // identical to English in non-en languages (possible untranslated) - report only for long strings
 v.slice(2).forEach((x,i)=>{if(x===v[0]&&x.length>12&&!/Trustwork|API|SEV/.test(x))console.log('SAME-AS-EN',k,i+2,x);});
 if(v[2]&&/[a-z]{4,}/.test(v[2].replace(/Trustwork|API|SEV|Ctrl|Esc/g,'')))console.log('LATIN-IN-RU?',k,v[2]);}
// keys referenced
const code=src.replace(m,'');const refs=new Set();for(const r of code.matchAll(/(?:\bt|tp|badge|lockBadge|tDynamic)\(\s*'([A-Za-z_][\w]*)'/g))refs.add(r[1]);for(const r of code.matchAll(/'@([A-Za-z_]\w*)'/g))refs.add(r[1]);
for(const r of code.matchAll(/\['([a-z]{1,6}_[A-Za-z0-9]+)'/g))refs.add(r[1]);
const missing=[...refs].filter(k=>!T[k]);console.log('keys',Object.keys(T).length,'refs',refs.size,'missing',missing.join(','));console.log('bad',bad);
