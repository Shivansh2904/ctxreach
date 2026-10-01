import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const summarize = (v, d=0) => Array.isArray(v) ? `[${v.length}]` : (v && typeof v === 'object') ? '{' + Object.keys(v).join(',') + '}' : typeof v;
console.log('top:', summarize(j));
const items = Array.isArray(j) ? j : (j.input ?? j.prompt?.input ?? j.items ?? Object.values(j).find(Array.isArray));
items.forEach((it, i) => {
  const texts = []; const walk = (o) => { if (typeof o === 'string') texts.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(walk); }; walk(it);
  const t = texts.join('\n');
  console.log(i, it.type, it.role, 'bytes', Buffer.byteLength(t), JSON.stringify(t.slice(0, 90)));
});
const all = JSON.stringify(j);
const block = items.map(it => JSON.stringify(it)).find(s => s.includes('AGENTS.md instructions'));
if (block) {
  const obj = JSON.parse(block); const texts=[]; const walk=(o)=>{ if(typeof o==='string') texts.push(o); else if(o&&typeof o==='object') Object.values(o).forEach(walk)}; walk(obj);
  const t = texts.find(x => x.includes('AGENTS.md instructions'));
  console.log('--- block head:', JSON.stringify(t.slice(0, 200)));
  const api = t.indexOf('# API');
  const end = t.indexOf('</INSTRUCTIONS>');
  const apiPart = t.slice(api, end);
  console.log('api part bytes (to </INSTRUCTIONS>):', Buffer.byteLength(apiPart), 'contains U+FFFD:', apiPart.includes('�'), 'tail:', JSON.stringify(apiPart.slice(-40)));
  const rootEnd = t.indexOf('CTXR-c0000002');
  console.log('between root tail and api head:', JSON.stringify(t.slice(rootEnd, api)));
  console.log('block tail:', JSON.stringify(t.slice(end - 10)));
}
