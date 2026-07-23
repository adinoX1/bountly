// Run with: node test_expiry_json.mjs
// Dare expiry in the JSON (non-LEDGER) store, driven through the real HTTP API
// in DEV mode. The LEDGER path has its own coverage in test_wallet.mjs; this is
// the half that runs when DATABASE_URL / LEDGER are not set.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };

const PORT = 3988;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bountly-json-'));
const dataFile = path.join(tmp, 'data.json');

function api(p, { user = 'creator', method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'X-Dev-User': user, 'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        let parsed = null; try { parsed = JSON.parse(txt); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let srv;
function boot(env = {}) {
  srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, UPLOAD_DIR: tmp,
      BOT_TOKEN: '', NODE_ENV: '', DATABASE_URL: '', LEDGER: '', SOLANA: '', ADMIN_IDS: 'boss', ...env },
    stdio: 'ignore',
  });
}
async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    try { const r = await api('/api/me'); if (r.status) return true; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
}
function stop() { return new Promise(r => { if (!srv) return r(); srv.once('exit', r); srv.kill(); }); }
function done() {
  if (srv) srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

try {
  boot();
  if (!await waitForBoot()) throw new Error('server never came up');

  console.log('\n-- the store is redirectable (DATA_FILE) --');
  ok(fs.existsSync(dataFile), 'server wrote to DATA_FILE, not the repo copy');

  console.log('\n-- a deadline is set by default --');
  let r = await api('/api/challenges', { method: 'POST', body: { title: 'Dated', desc: 'd', rules: 'r', reward: 5, maxWinners: 1 } });
  eq(r.status, 200, 'dare created');
  let list = (await api('/api/challenges')).body.challenges;
  const dated = list.find(c => c.code === r.body.code);
  ok(dated.expiresAt > Date.now(), 'default deadline is in the future');
  ok(dated.expiresAt <= Date.now() + 15 * 86400e3, 'default deadline is ~14 days out');
  eq(dated.expired, false, 'not expired yet');

  console.log('\n-- the deadline is validated --');
  eq((await api('/api/challenges', { method: 'POST', body: { title: 'x', desc: 'd', reward: 1, maxWinners: 1, expiresInDays: 0 } })).status, 400, 'expiresInDays=0 rejected');
  eq((await api('/api/challenges', { method: 'POST', body: { title: 'x', desc: 'd', reward: 1, maxWinners: 1, expiresInDays: 900 } })).status, 400, 'expiresInDays=900 rejected');
  r = await api('/api/challenges', { method: 'POST', body: { title: 'Short', desc: 'd', reward: 5, maxWinners: 1, expiresInDays: 1 } });
  eq(r.status, 200, 'expiresInDays=1 accepted');

  const before = (await api('/api/me')).body.user.credits;

  console.log('\n-- an overdue dare refunds its creator on the next sweep --');
  // rewrite the store with the deadline in the past, then restart to trigger the sweep
  await stop();
  const st = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  st.challenges.find(c => c.code === dated.code).expiresAt = Date.now() - 86400e3;
  fs.writeFileSync(dataFile, JSON.stringify(st));
  boot();
  if (!await waitForBoot()) throw new Error('server did not come back up');

  const after = (await api('/api/me')).body.user.credits;
  eq(after, before + 5, 'the full escrow came back');
  list = (await api('/api/challenges')).body.challenges;
  eq(list.find(c => c.code === dated.code).expired, true, 'dare marked expired');
  ok((await api('/api/me/activity')).body.txns.some(t => t.type === 'refund' && t.note.includes('expired')), 'a refund txn is recorded');

  console.log('\n-- expired dares refuse new proofs --');
  const expiredId = list.find(c => c.code === dated.code).id;
  r = await api(`/api/challenges/${expiredId}/submit`, { user: 'hunter', method: 'POST', body: { file: 'late.mp4' } });
  eq(r.status, 400, 'submitting to an expired dare is refused');
  eq(r.body.error, 'this dare has expired', 'with a clear reason');

  console.log('\n-- sweeping twice does not double-refund --');
  await stop(); boot();
  if (!await waitForBoot()) throw new Error('server did not come back up');
  eq((await api('/api/me')).body.user.credits, after, 'balance unchanged on the second sweep');

  console.log('\n-- a dare with a proof awaiting review is not expired --');
  r = await api('/api/challenges', { method: 'POST', body: { title: 'Pending', desc: 'd', reward: 5, maxWinners: 1, expiresInDays: 1 } });
  const pendCode = r.body.code;
  const pendId = (await api('/api/challenges')).body.challenges.find(c => c.code === pendCode).id;
  eq((await api(`/api/challenges/${pendId}/submit`, { user: 'hunter', method: 'POST', body: { file: 'p.mp4' } })).status, 200, 'hunter submits');
  const beforePend = (await api('/api/me')).body.user.credits;
  await stop();
  const st2 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  st2.challenges.find(c => c.code === pendCode).expiresAt = Date.now() - 86400e3;
  fs.writeFileSync(dataFile, JSON.stringify(st2));
  boot();
  if (!await waitForBoot()) throw new Error('server did not come back up');
  eq((await api('/api/me')).body.user.credits, beforePend, 'creator not refunded while a proof waits');
  eq((await api('/api/challenges')).body.challenges.find(c => c.code === pendCode).expired, false, 'dare still not marked expired');

  console.log('\n-- dispute / appeal (JSON mode) --');
  ok((await api('/api/me', { user: 'boss' })).body.user.isAdmin, 'boss is admin in DEV mode via ADMIN_IDS');
  r = await api('/api/challenges', { user: 'creator', method: 'POST', body: { title: 'Contest', desc: 'd', reward: 10, maxWinners: 1 } });
  const cCode = r.body.code;
  const cId = (await api('/api/challenges')).body.challenges.find(c => c.code === cCode).id;
  const sId = (await api(`/api/challenges/${cId}/submit`, { user: 'harry', method: 'POST', body: { file: 'h.mp4' } })).body.submissionId;
  eq((await api(`/api/admin/reject/${sId}`, { user: 'boss', method: 'POST', body: { reason: 'too dark' } })).status, 200, 'admin rejects');
  let act = await api('/api/me/activity', { user: 'harry' });
  eq(act.body.submissions.find(s => s.id === sId).canAppeal, true, 'a fresh rejection is appealable');
  eq((await api(`/api/submissions/${sId}/appeal`, { user: 'mallory', method: 'POST' })).status, 403, 'a stranger cannot appeal it');
  eq((await api(`/api/submissions/${sId}/appeal`, { user: 'harry', method: 'POST' })).status, 200, 'the owner appeals');
  eq((await api(`/api/submissions/${sId}/appeal`, { user: 'harry', method: 'POST' })).status, 400, 'cannot appeal twice');
  eq(act.body.submissions.find(s => s.id === sId) && (await api('/api/me/activity', { user: 'harry' })).body.submissions.find(s => s.id === sId).status, 'disputed', 'proof now shows disputed');
  eq((await api('/api/admin/disputes', { user: 'harry' })).status, 403, 'non-admin cannot read the dispute queue');
  const dq = await api('/api/admin/disputes', { user: 'boss' });
  eq(dq.body.disputes.length, 1, 'dispute queue has the appeal');
  eq(dq.body.disputes[0].reason, 'too dark', 'queue keeps the contested reason');
  const harryBefore = (await api('/api/me', { user: 'harry' })).body.user.credits;
  eq((await api(`/api/admin/dispute/${sId}/resolve`, { user: 'boss', method: 'POST', body: { uphold: false } })).status, 200, 'admin overturns');
  eq((await api('/api/me', { user: 'harry' })).body.user.credits, harryBefore + 9, 'harry paid 9 on the overturn');
  eq((await api('/api/admin/disputes', { user: 'boss' })).body.disputes.length, 0, 'dispute queue cleared');

  console.log('\n-- a disputed proof blocks expiry (JSON mode) --');
  r = await api('/api/challenges', { user: 'creator', method: 'POST', body: { title: 'Contest2', desc: 'd', reward: 10, maxWinners: 1, expiresInDays: 1 } });
  const c2Code = r.body.code;
  const c2Id = (await api('/api/challenges')).body.challenges.find(c => c.code === c2Code).id;
  const s2Id = (await api(`/api/challenges/${c2Id}/submit`, { user: 'harry', method: 'POST', body: { file: 'h2.mp4' } })).body.submissionId;
  await api(`/api/admin/reject/${s2Id}`, { user: 'boss', method: 'POST', body: { reason: 'nope' } });
  await api(`/api/submissions/${s2Id}/appeal`, { user: 'harry', method: 'POST' });
  const beforeC2 = (await api('/api/me', { user: 'creator' })).body.user.credits;
  await stop();
  const st3 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  st3.challenges.find(c => c.code === c2Code).expiresAt = Date.now() - 86400e3;
  fs.writeFileSync(dataFile, JSON.stringify(st3));
  boot();
  if (!await waitForBoot()) throw new Error('server did not come back up');
  eq((await api('/api/me', { user: 'creator' })).body.user.credits, beforeC2, 'creator not refunded while a dispute is open');
  eq((await api('/api/challenges')).body.challenges.find(c => c.code === c2Code).expired, false, 'contested dare not expired');
} catch (e) {
  fail++; console.log('  FAIL: threw', e.message);
}
done();
