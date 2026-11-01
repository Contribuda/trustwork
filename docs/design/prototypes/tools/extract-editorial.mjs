import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';const ts=createRequire(path.resolve(process.env.PROTOTYPE_DEPS||'.','package.json'))('typescript');
const html=fs.readFileSync('docs/design/prototypes/source/original-prototypes/editorial-prototype.html','utf8');
const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];const ast=ts.createSourceFile('editorial.js',js,ts.ScriptTarget.Latest,true);const pairs={};
function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='tt'&&n.arguments.length===2&&n.arguments.every(ts.isStringLiteral)){pairs[n.arguments[0].text]=n.arguments[1].text;}
if(ts.isArrayLiteralExpression(n)){n.elements.forEach((x,i)=>{const y=n.elements[i+1];if(ts.isStringLiteral(x)&&y&&ts.isStringLiteral(y)&&/[А-Яа-я]/.test(y.text)&&!/[А-Яа-я]/.test(x.text))pairs[x.text]=y.text;});}
ts.forEachChild(n,visit);} visit(ast);
fs.writeFileSync('/tmp/tw-editorial-pairs.json',JSON.stringify(pairs,null,2));console.log(Object.keys(pairs).length, 'pairs');
console.log(Object.keys(pairs).map((s,i)=>`${i}: ${s}`).join('\n'));
