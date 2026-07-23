// Run with: node test_frontend.mjs
// The mini app is one big inline <script>; a typo there breaks the whole app
// with no server-side signal at all. This parses every inline block and
// exercises the pure helpers that decide what a player sees.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };

function inlineScripts(file) {
  const s = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => ({ code: m[1], line: s.slice(0, m.index).split('\n').length }))
    .filter(b => b.code.trim());
}

console.log('\n-- every inline script parses --');
for (const file of ['index.html', 'admin.html', 'landing.html']) {
  for (const b of inlineScripts(file)) {
    try { new vm.Script(b.code, { filename: `${file}:${b.line}` }); pass++; console.log(`  ok ${file} (block at line ${b.line})`); }
    catch (e) { fail++; console.log(`  FAIL ${file}:${b.line} — ${e.message}`); }
  }
}

// Pull the two pure helpers out of the app source and run them for real, so the
// open/closed and countdown rules stay honest rather than merely syntactic.
const src = inlineScripts('index.html').map(b => b.code).join('\n');
const grab = name => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found in index.html`);
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name} is unbalanced`);
};
const ctx = vm.createContext({ Date, Math, String, JSON });
vm.runInContext([grab('isOpen'), grab('leftText'), grab('deadlineTag')].join('\n'), ctx);
const isOpen = code => vm.runInContext(`isOpen(${JSON.stringify(code)})`, ctx);
const tag = at => vm.runInContext(`deadlineTag(${JSON.stringify(at)})`, ctx);

const HOUR = 3600e3, DAY = 24 * HOUR;
console.log('\n-- isOpen: a dare is claimable only while slots AND time remain --');
ok(isOpen({ full: false }), 'no deadline, slots free → open');
ok(!isOpen({ full: true }), 'filled → closed');
ok(!isOpen({ full: false, expired: true }), 'JSON mode: expired flag → closed');
ok(!isOpen({ full: false, status: 'cancelled' }), 'LEDGER mode: cancelled status → closed');
ok(!isOpen({ full: false, status: 'closed' }), 'LEDGER mode: closed status → closed');
ok(isOpen({ full: false, status: 'open', expiresAt: Date.now() + DAY }), 'open status, future deadline → open');
ok(!isOpen({ full: false, expiresAt: Date.now() - 1000 }), 'past deadline → closed even before a sweep');
ok(isOpen({ full: false, expiresAt: Date.now() + 60e3 }), 'one minute left → still open');

console.log('\n-- deadlineTag: the countdown a player actually reads --');
eq(tag(null), '', 'no deadline renders nothing');
ok(tag(Date.now() - 1000).includes('expired'), 'past deadline says expired');
ok(tag(Date.now() + 30 * 60e3).includes('30m left'), 'under an hour counts minutes');
ok(tag(Date.now() + 5 * HOUR).includes('4h left') || tag(Date.now() + 5 * HOUR).includes('5h left'), 'under two days counts hours');
ok(tag(Date.now() + 6 * DAY).includes('5d left') || tag(Date.now() + 6 * DAY).includes('6d left'), 'beyond that counts days');
ok(tag(Date.now() + 3 * HOUR).includes('soon'), 'under 24h is flagged soon (amber)');
ok(!tag(Date.now() + 5 * DAY).includes('soon'), 'plenty of time is not flagged soon');

console.log('\n-- the create form and API agree on the field name --');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
ok(/id="f-x"/.test(html), 'deadline picker exists');
ok(/expiresInDays/.test(html), 'it is posted as expiresInDays');
ok(new RegExp('expiresInDays').test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'server.js reads expiresInDays');
ok(new RegExp('expiresInDays').test(fs.readFileSync(path.join(__dirname, 'server_ledger.js'), 'utf8')), 'server_ledger.js reads expiresInDays');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
