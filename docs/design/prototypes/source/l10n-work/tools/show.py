import json,sys
r=json.load(open('verify-%s.json'%sys.argv[1]))
for k in ['console','network','leaks','overflow','keyboard']:
    print('==',k,len(r[k]))
    for x in r[k][:int(sys.argv[2]) if len(sys.argv)>2 else 40]: print(json.dumps(x,ensure_ascii=False)[:400])
print('== same',len(r['same']))
for x in r['same'][:int(sys.argv[3]) if len(sys.argv)>3 else 80]: print(json.dumps(x,ensure_ascii=False)[:300])
