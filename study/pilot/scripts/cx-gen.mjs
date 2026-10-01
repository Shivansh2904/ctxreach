import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
const root = process.argv[2]; fs.rmSync(root, { recursive: true, force: true });
const w = (rel, s) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return Buffer.byteLength(s); };
fs.mkdirSync(root, { recursive: true }); execSync('git init -q --template=', { cwd: root });
// Root AGENTS.md: exactly 30000 bytes, head + tail tokens.
const head = '# Root\nCTXR-c0000001\n'; const tail = '\nCTXR-c0000002\n';
let filler = ''; let i = 0; while (Buffer.byteLength(head + filler + tail) < 30000) filler += `line ${i++} filler text for the budget test.\n`;
let rootTxt = head + filler; rootTxt = rootTxt.slice(0, 30000 - Buffer.byteLength(tail)); rootTxt += tail;
console.log('root bytes', w('AGENTS.md', rootTxt));
// packages/api/AGENTS.md: budget left = 32768-30000 = 2768. Put a 3-byte char (U+65E5) starting at byte 2767 so the cut splits it.
const ah = '# API\nCTXR-c0000003\n'; let body = ah; while (Buffer.byteLength(body) < 1500) body += 'api rule text. ';
body += '\nCTXR-c0000004\n'; while (Buffer.byteLength(body) < 2767) body += 'x';
body = Buffer.from(body).subarray(0, 2767).toString('utf8'); body += '日本\n'; // cut at 2768 splits the first char
while (Buffer.byteLength(body) < 4000) body += 'more api text. ';
body += '\nCTXR-c0000009\n';
console.log('api bytes', w('packages/api/AGENTS.md', body), 'mid token offset', Buffer.from(body).indexOf('CTXR-c0000004'), 'tail token offset', Buffer.from(body).indexOf('CTXR-c0000009'));
// tools/: whitespace-only override takes the slot (codex.empty-skip).
w('tools/AGENTS.override.md', '   \n\n'); w('tools/AGENTS.md', '# Tools\nCTXR-c0000006\n');
// below the launch dir and a decoy
w('packages/api/deep/AGENTS.md', '# Deep\nCTXR-c0000008\n'); w('packages/api/ctxreach-decoy.md', 'CTXR-c0000007\n');
