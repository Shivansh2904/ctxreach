import json,sys,re
pi,toks=sys.argv[1],sys.argv[2]
d=json.load(open(pi,encoding='utf-8')); t=json.load(open(toks))
blk=[c['text'] for it in d if it.get('role')=='user' for c in it['content'] if c.get('type')=='input_text' and c['text'].startswith('# AGENTS.md instructions')]
print('AGENTS blocks:',len(blk))
if blk:
  b=blk[0]; print('header:',b.split('\n')[0]); 
  m=re.search(r'<INSTRUCTIONS>\n(.*)\n</INSTRUCTIONS>',b,re.S)
  body=m.group(1) if m else b
  bb=body.encode('utf-8'); print('body bytes:',len(bb), 'U+FFFD count:', body.count('�'))
  print('last 80 bytes of body:', repr(body[-80:]))
  for f,v in t.items():
    for k in ('head','tail'):
      print(f"{f:28} {k}: {'SEEN at byte '+str(bb.find(v[k].encode())) if v[k] in body else 'not seen'}")
allt=json.dumps(d)
for f,v in t.items():
  for k in ('head','tail'):
    if v[k] in allt and not (blk and v[k] in blk[0]): print('token elsewhere in prompt:',f,k)
