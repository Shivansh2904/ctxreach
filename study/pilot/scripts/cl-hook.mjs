import fs from 'node:fs';
let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{ fs.appendFileSync(process.argv[2], d.replace(/\s*$/,'')+'\n'); });
