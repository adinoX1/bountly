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
// The clock moves between building the input and reading the output, so an
// exact deadline legitimately renders one unit short. Each tag is rendered
// ONCE and matched against both — rendering twice and OR-ing the results
// fails whenever the boundary falls between the two calls.
ok(/\b(29|30)m left/.test(tag(Date.now() + 30 * 60e3)), 'under an hour counts minutes');
ok(/\b(4|5)h left/.test(tag(Date.now() + 5 * HOUR)), 'under two days counts hours');
ok(/\b(5|6)d left/.test(tag(Date.now() + 6 * DAY)), 'beyond that counts days');
ok(tag(Date.now() + 3 * HOUR).includes('soon'), 'under 24h is flagged soon (amber)');
ok(!tag(Date.now() + 5 * DAY).includes('soon'), 'plenty of time is not flagged soon');

console.log('\n-- deposit flow helpers --');
const dctx = vm.createContext({ Date, Math, String, JSON, encodeURIComponent, DEP: {} });
vm.runInContext([grab('depMethods'), grab('depDeepLink'), grab('depMin')].join('\n'), dctx);
const methods = wcfg => vm.runInContext(`depMethods(${JSON.stringify(wcfg)})`, dctx);
const setDEP = d => { dctx.DEP = d; };
const link = () => vm.runInContext('depDeepLink()', dctx);

const wTonSol = { address: 'EQtonaddr', jetton: 'EQjetton', network: 'testnet',
  comment: 'alice', sol: { address: 'SoLaddr', mint: 'MintUSDC', network: 'devnet', min: 0.5 } };
eq(methods(wTonSol).length, 2, 'both chains configured → two methods');
eq(methods({ address: 'x', network: 'testnet' }).length, 1, 'only TON → one method');
eq(methods({ sol: { address: 'y', mint: 'm', network: 'devnet', min: 1 } }).length, 1, 'only Solana → one method');
eq(methods({}).length, 0, 'nothing configured → no methods (screen shows "not live")');

setDEP({ w: wTonSol, method: 'ton', amount: '' });
ok(link().startsWith('https://app.tonkeeper.com/transfer/EQtonaddr'), 'TON deep link targets the deposit address');
ok(link().includes('text=alice'), 'TON deep link carries the username as the comment');
ok(link().includes('jetton=EQjetton'), 'TON deep link carries the USDT jetton');
setDEP({ w: wTonSol, method: 'sol', amount: '' });
ok(link().startsWith('solana:SoLaddr'), 'Solana link targets the per-user address');
ok(link().includes('spl-token=MintUSDC'), 'Solana link pins the USDC mint (no look-alikes)');
ok(!link().includes('amount='), 'no amount param when the field is blank');
setDEP({ w: wTonSol, method: 'sol', amount: '25' });
ok(link().includes('amount=25'), 'a typed amount rides along on the Solana link');

console.log('\n-- balances read as money, not "credits" --');
const mctx = vm.createContext({ Number, Math, isFinite });
vm.runInContext(grab('money'), mctx);
const money = n => vm.runInContext(`money(${JSON.stringify(n)})`, mctx);
eq(money(42), '$42', 'a whole balance stays clean');
eq(money(0), '$0', 'zero is zero');
eq(money(2.5), '$2.50', 'a fractional deposit keeps its cents');
eq(money(0.75), '$0.75', 'so does a sub-dollar one');
eq(money(-5), '−$5', 'a debit is signed, with the symbol still leading');
eq(money(undefined), '—', 'a missing balance renders as a dash, not $NaN');
ok(!/\bcr\b/.test(money(42)), 'nothing says "cr" any more');

// The dashboard carries its own copy — it must agree, or the same balance
// reads differently depending on which screen an operator is looking at.
const adminSrc = inlineScripts('admin.html').map(b => b.code).join('\n');
const grabFrom = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name} is unbalanced`);
};
const actx = vm.createContext({ Number, Math, isFinite });
vm.runInContext(grabFrom(adminSrc, 'money'), actx);
for (const n of [42, 0, 2.5, 0.75, -5]) {
  eq(vm.runInContext(`money(${n})`, actx), money(n), `dashboard agrees on ${n}`);
}

console.log('\n-- no screen still talks in "credits" --');
for (const f of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
  // strip the identifiers that legitimately keep the old name (API fields,
  // element ids, the /credits/ route) before looking at what a user reads
  const copy = html
    .replace(/\b(ME|user|pl|x|u2?)\.credits\b/g, '')
    .replace(/credits\s*:/g, '').replace(/\/credits\//g, '')
    .replace(/creditsInPlay/g, '').replace(/\bcr-[\w${.}]+/g, '')
    .replace(/data-(setcr|cr)=/g, '').replace(/dataset\.(setcr|cr)\b/g, '')
    .replace(/\/\/[^\n]*/g, '');
  ok(!/\d\s*cr\b/.test(copy), `${f}: no amount is labelled "cr"`);
  ok(!/>\s*(Set )?[Cc]redits\s*</.test(copy), `${f}: no visible "Credits" label`);
}

console.log('\n-- the live confirmation status a depositor watches --');
const sctx = vm.createContext({ Date, Math, String, JSON, Number, isFinite });
vm.runInContext([grab('money'), grab('depStatusView')].join('\n'), sctx);
const view = (pending, gained) => vm.runInContext(`depStatusView(${JSON.stringify(pending)}, ${JSON.stringify(gained || 0)})`, sctx);

let v = view([], 0);
eq(v.cls, '', 'nothing in flight → the plain watching state');
ok(/watching/i.test(v.text), 'and it says we are watching the chain');

v = view([{ status: 'seen', amount: 25, confirms: 0, need: 3 }], 0);
eq(v.cls, 'seen', 'a sighting switches the status line');
ok(v.text.includes('25'), 'it names the amount it found');
ok(/first confirmation/.test(v.text), 'zero confirmations reads as waiting for the first');
ok(v.pct > 0, 'the bar is visible even at zero so it does not look stalled');

v = view([{ status: 'seen', amount: 25, confirms: 2, need: 3 }], 0);
ok(v.text.includes('(2/3)'), 'progress is shown as confirmations out of the requirement');
eq(v.pct, 67, 'and the bar tracks it');

v = view([{ status: 'seen', amount: 25, confirms: 9, need: 3 }], 0);
eq(v.pct, 100, 'the bar never overshoots 100%');
v = view([{ status: 'seen', amount: 25, confirms: 1, need: 0 }], 0);
ok(v.pct <= 100 && v.pct > 0, 'a nonsense requirement cannot produce a broken bar');

v = view([{ status: 'seen', amount: 25, confirms: 2, need: 3 }], 25);
eq(v.cls, 'done', 'once credited, the credit wins over any in-flight row');
ok(v.text.includes('+$25'), 'and names what landed, as money');

v = view([{ status: 'failed', amount: 25, detail: 'transaction aborted on-chain' }], 0);
eq(v.cls, 'bad', 'a failed transfer is shown as failed');
ok(/aborted/.test(v.text), 'with the chain\'s reason');
ok(/nothing was credited/i.test(v.text), 'and reassurance that no money moved');

console.log('\n-- the create form and API agree on the field name --');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
ok(/id="f-x"/.test(html), 'deadline picker exists');
ok(/expiresInDays/.test(html), 'it is posted as expiresInDays');
ok(new RegExp('expiresInDays').test(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')), 'server.js reads expiresInDays');
ok(new RegExp('expiresInDays').test(fs.readFileSync(path.join(__dirname, 'server_ledger.js'), 'utf8')), 'server_ledger.js reads expiresInDays');

// These come from finding loadBoard(): a whole feature that rendered into a
// #board no markup contained, with no tab and no view, so nothing could reach
// it and nothing ever complained. Dead wiring is invisible at runtime — that
// one survived a full redesign. Generic on purpose: they fail for ANY tab or
// selector wired to nothing, not just the case that prompted them.
console.log('\n-- every tab has a view, and every view a tab --');
const tabIds  = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
const viewIds = [...html.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]);
// 'in'/'out' are the deposit/withdraw sheet toggle, not navigation tabs.
const navTabs = [...new Set(tabIds)].filter(t => t !== 'in' && t !== 'out');
// the admin tab and its view are both injected at runtime for admins only
const runtime = new Set(['admin']);
for (const t of navTabs) {
  if (runtime.has(t)) continue;
  ok(viewIds.includes(t), `tab "${t}" has a matching <section data-view="${t}">`);
}
for (const v of new Set(viewIds)) ok(navTabs.includes(v), `view "${v}" is reachable from the tab bar`);
// go() must actually load something for each tab that has data to fetch
const goBody = grab('go');
for (const t of ['bounties', 'profile']) {
  ok(new RegExp(`t==='${t}'\\)\\s*load`).test(goBody), `go('${t}') triggers its loader`);
}
// and it must not dispatch to a loader that no longer exists
for (const m of goBody.matchAll(/load([A-Z]\w+)\(/g)) {
  ok(src.includes(`function load${m[1]}(`), `go() calls load${m[1]}(), which is defined`);
}

console.log('\n-- no selector points at an element that does not exist --');
const ids = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
// ids built at runtime: assigned via .id = '…', or interpolated into a template
for (const m of html.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
for (const m of html.matchAll(/id=\\?["']([A-Za-z0-9_-]+)\\?["']/g)) ids.add(m[1]);
const reached = new Set([...src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
for (const m of src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) reached.add(m[1]);
const dangling = [...reached].filter(i => !ids.has(i));
eq(dangling.length, 0, `every $('#id') resolves${dangling.length ? ' — dangling: ' + dangling.join(', ') : ''}`);

console.log('\n-- the app has no leaderboard, and no leftovers of one --');
ok(!/loadBoard/.test(src), 'loadBoard() is gone, not left dangling');
ok(!/id="board"/.test(html), 'no #board container');
ok(!/data-(tab|view)="board"/.test(html), 'no board tab or view');
// The endpoint stays: it is correct, both backends serve it, and a board may
// be wanted later. It is the client-side half that was dead weight.
for (const f of ['server.js', 'server_ledger.js']) {
  const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
  ok(/\/api\/leaderboard/.test(s), `${f} still serves /api/leaderboard`);
}

console.log('\n-- comments are the first user-written text the app renders --');
// Every other string in a slide comes from a creator posting a dare, which is
// already escaped the same way. Comments are typed by anyone about anyone, so
// this is the one that gets a standing test rather than a careful review.
const renderC = grab('renderComments');
ok(/esc\(c\.body\)/.test(renderC), 'the comment body goes through esc()');
ok(/esc\(c\.player\)/.test(renderC), 'so does the author name');
ok(!/innerHTML\s*=\s*[^;]*\$\{c\.body\}/.test(renderC), 'the raw body is never interpolated unescaped');
// esc() is the whole defence, so pin down what it actually neutralises.
const escFn = grab('esc');
const escCtx = vm.createContext({ String });
vm.runInContext(escFn, escCtx);
const esc = s => vm.runInContext(`esc(${JSON.stringify(s)})`, escCtx);
ok(!esc('<img src=x onerror=alert(1)>').includes('<img'), 'a tag cannot survive esc()');
ok(!esc('"><script>').includes('<script'), 'nor a script tag after breaking an attribute');
ok(!esc(`' onmouseover='x`).includes("'"), 'nor a single quote, which would break out of an attribute');
ok(!esc('a & b').includes('& b'), 'and the ampersand is encoded first, not doubly');

console.log('\n-- reactions: one tap, optimistic, reconciled --');
const tr = grab('toggleReaction');
ok(/paintReaction\(btn,next/.test(tr), 'the tap paints before the request, so it feels instant');
ok(/paintReaction\(btn,r\.mine,r\.total\)/.test(tr), 'and repaints from the server answer');
ok(/catch\s*\(e\)\s*\{[\s\S]*paintReaction\(btn,was/.test(tr), 'a failed request rolls the optimistic paint back');
ok(/dataset\.busy/.test(tr), 'a second tap while one is in flight is ignored');
// The rail button sits on top of the slide, whose own click opens the sheet.
const slideHandler = src.slice(src.indexOf('c.onclick=(e)=>{'), src.indexOf('c.onkeydown'));
for (const sel of ['data-player', 'data-share', 'data-react', 'data-comments']) {
  ok(new RegExp(`closest\\('\\[${sel}\\]'\\)`).test(slideHandler),
    `${sel} gets out of the slide's own click handler`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
