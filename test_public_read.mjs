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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
