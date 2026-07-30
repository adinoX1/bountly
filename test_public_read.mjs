// Run with: node test_public_read.mjs
//
// The web version of the app is a logged-out browser: no Telegram, no
// initData, no session. For it to show anything, two GETs have to answer
// without one — and, far more importantly, nothing else may.
//
// This boots the real server with a bot token set (so DEV_AUTH is off and the
// gate actually bites) against a throwaway data file, then knocks on the door
// with no credentials at all. The half of this test that matters is the second
// half: every write must still come back 401.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});

const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'bountly-test-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    // A token, so DEV_AUTH is off and verifyTelegram() is the thing answering.
    BOT_TOKEN: 'test-token-not-a-real-bot',
    DATA_FILE: path.join(tmp, 'data.json'),
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    // Keep the test off the network and off any real chain.
    DATABASE_URL: '', LEDGER: '', SOLANA: '', NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

const cleanup = () => {
  try { child.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// ---- wait for it to listen ------------------------------------------------
let up = false;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch(BASE + '/api/challenges', { signal: AbortSignal.timeout(500) });
    if (r.status) { up = true; break; }
  } catch { await new Promise(r => setTimeout(r, 100)); }
}
if (!up) {
  console.log('  FAIL: server never came up\n' + serverLog);
  console.log('\nRESULT: 0 passed, 1 failed');
  cleanup();
  process.exit(1);
}

const get  = (p, h)    => fetch(BASE + p, { headers: h || {} });
const post = (p, h)    => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: '{}' });

console.log('\n-- the web can read a bounty without Telegram --');
{
  const r = await get('/api/challenges');
  eq(r.status, 200, 'GET /api/challenges answers a request with no session');
  const body = await r.json();
  ok(Array.isArray(body.challenges), 'and returns a challenges array');
  ok(body.challenges.length > 0, 'with the seeded dares in it');

  const one = await get('/api/challenges/1');
  eq(one.status, 200, 'GET /api/challenges/1 answers too');
  const ch = (await one.json()).challenge;
  ok(ch && ch.title, 'the single dare carries its title');
  // The anonymous reader has no submissions, and asking must not throw.
  eq(ch.mySubmission, false, 'mySubmission is false rather than a crash');
  ok(!('credits' in ch), 'no per-user money rides along on a public read');
}

console.log('\n-- and nothing else --');
{
  eq((await get('/api/me')).status, 401, 'GET /api/me still needs a session');
  eq((await get('/api/me/activity')).status, 401, 'so does my activity');
  eq((await get('/api/leaderboard')).status, 401, 'so does the leaderboard');
  eq((await post('/api/challenges')).status, 401, 'posting a bounty is refused');
  eq((await post('/api/challenges/1/submit')).status, 401, 'submitting proof is refused');
  eq((await post('/api/challenges/1/react')).status, 401, 'reacting is refused');
  eq((await post('/api/wallet/withdraw')).status, 401, 'withdrawing is refused');
  eq((await post('/api/wallet/scan')).status, 401, 'scanning the chain is refused');
}

console.log('\n-- a forged header is not a session --');
{
  // The public GETs are open to everyone, so they are not the interesting
  // case. What matters is that made-up initData buys nothing.
  const junk = { 'X-Telegram-Init': 'user=%7B%22id%22%3A1%7D&hash=deadbeef' };
  eq((await post('/api/challenges', junk)).status, 401, 'a made-up hash cannot post a bounty');
  eq((await get('/api/me', junk)).status, 401, 'nor read an account');
  eq((await post('/api/wallet/withdraw', junk)).status, 401, 'nor move money');
}

console.log('\n-- the mini app and the landing page are both served --');
{
  const app = await get('/app');
  eq(app.status, 200, 'GET /app serves the mini app');
  const html = await app.text();
  ok(/const WEB\s*=\s*!INIT/.test(html), 'which knows how to run without Telegram');

  const landing = await get('/');
  eq(landing.status, 200, 'GET / serves the landing page');
  ok(/href="\/app"/.test(await landing.text()), 'and the landing links into the web app');
}

// ---- signing in from a browser -------------------------------------------
// The website authenticates with Telegram's Login Widget, which is signed with
// a different secret than the mini app: SHA-256 of the bot token rather than
// HMAC("WebAppData", token). The test knows the token, so it can produce a
// genuine payload — and, more to the point, forge every near-miss.
const BOT = 'test-token-not-a-real-bot';
const widgetHash = fields => {
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(BOT).digest();
  return crypto.createHmac('sha256', secret).update(dcs).digest('hex');
};
const signIn = async (over = {}) => {
  const f = { id: 777001, first_name: 'Web', username: 'webuser',
              auth_date: Math.floor(Date.now() / 1000), ...over };
  const body = { ...f, hash: over.hash || widgetHash(f) };
  const r = await fetch(BASE + '/api/auth/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('\n-- a browser can sign in with a real Telegram payload --');
let session = '';
{
  const r = await signIn();
  eq(r.status, 200, 'a correctly signed payload is accepted');
  ok(typeof r.body.token === 'string' && r.body.token.length > 20, 'and answers with a session token');
  ok(r.body.user && r.body.user.username === 'webuser', 'for the account Telegram named');
  session = r.body.token;
}

console.log('\n-- and only with a real one --');
{
  eq((await signIn({ hash: 'deadbeef'.repeat(8) })).status, 401, 'a made-up hash is refused');
  // The giveaway case: signing the payload the *mini app* way. Same data, same
  // token, different derivation — accepting it would mean either surface's
  // signature works on the other.
  const f = { id: 777002, first_name: 'X', username: 'x', auth_date: Math.floor(Date.now()/1000) };
  const dcs = Object.keys(f).sort().map(k => `${k}=${f[k]}`).join('\n');
  const miniSecret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const miniHash = crypto.createHmac('sha256', miniSecret).update(dcs).digest('hex');
  eq((await signIn({ ...f, hash: miniHash })).status, 401, 'a mini-app signature does not open the website');
  // Changing any field after signing must break the signature.
  const good = { id: 777003, first_name: 'Y', username: 'y', auth_date: Math.floor(Date.now()/1000) };
  eq((await signIn({ ...good, id: 999999, hash: widgetHash(good) })).status, 401,
     'swapping the id after signing is caught');
  eq((await signIn({ auth_date: Math.floor(Date.now()/1000) - 90000 })).status, 401,
     'a payload from yesterday is expired');
  eq((await signIn({ auth_date: 0 })).status, 401, 'and one with no timestamp is refused outright');
}

console.log('\n-- the session token is worth what initData is worth --');
{
  const me = await fetch(BASE + '/api/me', { headers: { 'X-Session': session } });
  eq(me.status, 200, 'GET /api/me answers for a signed-in browser');
  const who = (await me.json()).user;
  eq(who.username, 'webuser', 'and it is the right account');

  // Tampering: the id is inside the signed body, so bending it must fail.
  const parts = session.split('.');
  const bent = ['999999', parts[1], parts[2]].join('.');
  eq((await fetch(BASE + '/api/me', { headers: { 'X-Session': bent } })).status, 401,
     'pointing a token at another account breaks its signature');
  eq((await fetch(BASE + '/api/me', { headers: { 'X-Session': parts[0] + '.' + parts[1] + '.' + 'f'.repeat(64) } })).status, 401,
     'and so does replacing the signature');

  // A validly signed but expired token. The key is derived from the bot token,
  // which this test holds, so this is the real thing — only stale.
  const key = crypto.createHmac('sha256', 'BountlyWebSession').update(BOT).digest();
  const stale = `777001.${Date.now() - 1000}`;
  const staleTok = `${stale}.${crypto.createHmac('sha256', key).update(stale).digest('hex')}`;
  eq((await fetch(BASE + '/api/me', { headers: { 'X-Session': staleTok } })).status, 401,
     'an expired token is refused even though it is genuinely signed');

  // And the whole point: a signed-in browser can do the things it came for.
  const post = await fetch(BASE + '/api/challenges', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session': session },
    body: JSON.stringify({ title: 'From the web', desc: 'd', rules: 'r', reward: 1, maxWinners: 1 }) });
  ok(post.status !== 401, `posting a dare is no longer unauthorized (got ${post.status})`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
