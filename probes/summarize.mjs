// node summarize.mjs out/<file>.ndjson [maxChars]
import fs from 'node:fs';
const f = process.argv[2];
const max = Number(process.argv[3] ?? 600);
const cut = (o) => { const s = JSON.stringify(o); return s.length > max ? s.slice(0, max) + '…' : s; };
const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const seen = new Map();
for (const l of lines) {
  if (l.type === 'probe_start') console.log('CMD', l.cmd.join(' '));
  if (l.type === 'initialize_response') console.log('INIT', cut(l.init));
  if (l.type === 'new_session_response') console.log('NEWSESSION', cut(l.sess));
  if (l.type === 'session_update') {
    const k = l.kind;
    seen.set(k, (seen.get(k) ?? { n: 0, ex: l.params.update }));
    seen.get(k).n++;
  }
  if (l.type === 'request_permission') console.log('PERMISSION', cut(l.params), 'ANSWER', l.answer);
  if (l.type === 'fs_read' || l.type === 'fs_write') console.log(l.type.toUpperCase(), cut(l.params));
  if (l.type === 'prompt_response') console.log('STOP', l.stopReason, cut(l.res));
  if (l.type === 'error' || l.type === 'timeout' || l.type === 'spawn_error') console.log(l.type.toUpperCase(), cut(l));
  if (l.type === 'probe_end') console.log('END', cut(l));
}
for (const [k, v] of seen) console.log(`UPDATE ${k} x${v.n}:`, cut(v.ex));
