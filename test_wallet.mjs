// Run with: node test_wallet.mjs
import { PGlite } from '@electric-sql/pglite';
import * as W from './wallet.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${a}, want ${b})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };
async function throws(fn, m) { try { await fn(); fail++; console.log('  FAIL (no throw):', m); } catch (e) { pass++; console.log('  rejected:', m); } }

const db = new PGlite();
await W.initLedger(db);

console.log('\n-- deposit + create dare with content --');
await W.deposit(db, 'creator', 100, 'tx1');
eq(await W.balance(db, 'creator'), 100, 'creator balance 100 after deposit');

const { code } = await W.createDare(db, { creatorId: 'creator', title: 'Ice bucket', desc: 'Pour ice water', rules: 'Say the code', rewardUsdt: 10, maxWinners: 2 });
eq(code, 'BNT-001', 'dare code BNT-001');
eq(await W.balance(db, 'creator'), 79, 'creator paid 21 (20 escrow + 1 fee)');

const dares = await W.listDares(db);
eq(dares.length, 1, 'one dare listed');
eq(dares[0].title, 'Ice bucket', 'content title preserved');
eq(dares[0].reward, 10, 'reward shown as 10 USDT');

console.log('\n-- submit + approve --');
const a1 = await W.submit(db, { dareId: dares[0].id, hunterId: 'alice', vhash: 'a', file: 'a.mp4', video: 'sub_1.mp4' });
const a2 = await W.submit(db, { dareId: dares[0].id, hunterId: 'bob', vhash: 'b', file: 'b.mp4', video: 'sub_2.mp4' });
eq((await W.adminQueue(db)).length, 2, 'admin queue has 2 pending');
await W.approve(db, a1.submissionId);
eq(await W.balance(db, 'alice'), 9, 'alice paid 9');
await W.approve(db, a2.submissionId);
eq(await W.balance(db, 'bob'), 9, 'bob paid 9');

console.log('\n-- read models --');
const lb = await W.leaderboard(db);
ok(lb.find(x => x.username === 'alice' && x.wins === 1 && x.earnedUsdt === 9), 'leaderboard alice 1 win / 9 earned');
ok((await W.recentTxns(db, 50)).some(t => t.type === 'payout'), 'ledger txns include payouts');

console.log('\n-- guard: extra winner rejected --');
const dg = await W.createDare(db, { creatorId: 'creator', title: 'G', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1 });
const g1 = await W.submit(db, { dareId: dg.dareId, hunterId: 'gina', vhash: 'g1' });
const g2 = await W.submit(db, { dareId: dg.dareId, hunterId: 'gwen', vhash: 'g2' });
await W.approve(db, g1.submissionId);
await throws(() => W.approve(db, g2.submissionId), 'approving past the only slot is rejected');

console.log('\n-- refund a partly-filled dare --');
const d2 = await W.createDare(db, { creatorId: 'creator', title: 'Sing', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 3 });
const s4 = await W.submit(db, { dareId: d2.dareId, hunterId: 'dan', vhash: 'd' });
await W.approve(db, s4.submissionId);
const r = await W.refund(db, d2.dareId);
eq(r.refunded, W.MICRO * 20, 'refunded 20 USDT (2 unpaid slots)');

console.log('\n-- submit guards --');
const dsg = await W.createDare(db, { creatorId: 'creator', title: 'Guards', desc: 'x', rules: 'y', rewardUsdt: 5, maxWinners: 1 });
await throws(() => W.submit(db, { dareId: dsg.dareId, hunterId: 'creator', vhash: 'own' }), "creator can't complete their own dare");
await W.submit(db, { dareId: dsg.dareId, hunterId: 'hank', vhash: 'h1' });
await throws(() => W.submit(db, { dareId: dsg.dareId, hunterId: 'hank', vhash: 'h2' }), 'second live submission by the same hunter is rejected');
await throws(() => W.submit(db, { dareId: 999999, hunterId: 'hank', vhash: 'h3' }), 'submitting to a missing dare is rejected');

console.log('\n-- a rejected hunter can try again (uniq_live_submission is partial) --');
const dr2 = await W.createDare(db, { creatorId: 'creator', title: 'Retry', desc: 'x', rules: 'y', rewardUsdt: 5, maxWinners: 1 });
const r1 = await W.submit(db, { dareId: dr2.dareId, hunterId: 'rita', vhash: 'r1' });
await W.reject(db, r1.submissionId, 'too dark');
const r2 = await W.submit(db, { dareId: dr2.dareId, hunterId: 'rita', vhash: 'r2' });
ok(r2.submissionId > 0, 'rita re-submits after a rejection');
await W.approve(db, r2.submissionId);
eq(await W.balance(db, 'rita'), 4.5, 'rita paid 4.5 on the retry');

console.log('\n-- slots full blocks new proofs --');
await throws(() => W.submit(db, { dareId: dr2.dareId, hunterId: 'rob', vhash: 'r3' }), 'submitting to a filled dare is rejected');

console.log('\n-- editDare: text only --');
await W.editDare(db, dsg.dareId, { title: 'Renamed', rules: 'New rules' });
const edited = (await W.listDares(db)).find(d => d.id === dsg.dareId);
eq(edited.title, 'Renamed', 'title updated');
eq(edited.rules, 'New rules', 'rules updated');
eq(edited.reward, 5, 'reward untouched by an edit');
await throws(() => W.editDare(db, 999999, { title: 'x' }), 'editing a missing dare is rejected');

console.log('\n-- deposit refs stay unique (admin-set bug) --');
await throws(() => W.deposit(db, 'creator', 5, 'tx1'), 'reusing a deposit txhash is rejected');
await W.deposit(db, 'creator', 5, 'admin-set:' + crypto.randomUUID());
await W.deposit(db, 'creator', 5, 'admin-set:' + crypto.randomUUID());
ok(true, 'two admin-set adjustments both land (unique refs)');

console.log('\n-- dare expiry --');
await W.deposit(db, 'expo', 200, 'tx-expo');
const never = await W.createDare(db, { creatorId: 'expo', title: 'No deadline', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1 });
eq(never.expiresAt, null, 'no deadline by default at the wallet layer');
const dated = await W.createDare(db, { creatorId: 'expo', title: 'Dated', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1, expiresInDays: 7 });
ok(dated.expiresAt > Date.now(), 'deadline is in the future');
ok((await W.listDares(db)).find(d => d.id === dated.dareId).expiresAt === dated.expiresAt, 'deadline is exposed to the UI');
await throws(() => W.createDare(db, { creatorId: 'expo', title: 'Bad', desc: 'x', rules: 'y', rewardUsdt: 1, maxWinners: 1, expiresInDays: 0 }), 'expiresInDays=0 is rejected');
await throws(() => W.createDare(db, { creatorId: 'expo', title: 'Bad', desc: 'x', rules: 'y', rewardUsdt: 1, maxWinners: 1, expiresInDays: 900 }), 'expiresInDays=900 is rejected');

let bal = await W.balance(db, 'expo');
let sweep = await W.expireDares(db);
eq(sweep.expired.length, 0, 'nothing expires before its deadline');
eq(await W.balance(db, 'expo'), bal, 'balance untouched');

// push both dares into the past; only the dated one should be swept
await db.query(`UPDATE dares SET expires_at = now() - interval '1 day' WHERE id=$1`, [dated.dareId]);
sweep = await W.expireDares(db);
eq(sweep.expired.length, 1, 'the overdue dare is swept');
eq(sweep.expired[0].refundedUsdt, 10, 'its full escrow comes back');
eq(await W.balance(db, 'expo'), bal + 10, 'creator refunded');
eq((await W.listDares(db)).find(d => d.id === dated.dareId).status, 'cancelled', 'dare marked cancelled');
eq((await W.expireDares(db)).expired.length, 0, 'sweeping twice does not double-refund');
await throws(() => W.submit(db, { dareId: dated.dareId, hunterId: 'late', vhash: 'late1' }), 'cannot submit to an expired dare');

console.log('\n-- expiry defers to hunters waiting on review --');
const pend = await W.createDare(db, { creatorId: 'expo', title: 'Pending', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1, expiresInDays: 7 });
await W.submit(db, { dareId: pend.dareId, hunterId: 'patient', vhash: 'p1' });
await db.query(`UPDATE dares SET expires_at = now() - interval '1 day' WHERE id=$1`, [pend.dareId]);
sweep = await W.expireDares(db);
eq(sweep.expired.length, 0, 'a dare with a pending proof is not expired');
eq(sweep.blocked.length, 1, 'it is reported as blocked instead');
eq(sweep.blocked[0].code, (await W.listDares(db)).find(d => d.id === pend.dareId).code, 'blocked entry names the dare');
// once the proof is reviewed the sweeper can proceed
await W.reject(db, (await W.adminQueue(db)).find(q => q.player === 'patient').id, 'not valid');
sweep = await W.expireDares(db);
eq(sweep.expired.length, 1, 'after review the dare expires normally');

console.log('\n-- the deadline gap is closed --');
// past its deadline but the sweeper has not run yet: still status='open'
const gap = await W.createDare(db, { creatorId: 'expo', title: 'Gap', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1, expiresInDays: 7 });
await db.query(`UPDATE dares SET expires_at = now() - interval '1 second' WHERE id=$1`, [gap.dareId]);
eq((await W.listDares(db)).find(d => d.id === gap.dareId).status, 'open', 'still open until the sweeper runs');
await throws(() => W.submit(db, { dareId: gap.dareId, hunterId: 'sneaky', vhash: 'sneak' }), 'no slipping a proof in through the gap');

console.log('\n-- invariants --');
eq(await W.conservation(db), 0, 'everything sums to 0');
ok((await W.reconcile(db)).length === 0, 'cached balances match journal');
console.log('  liabilities:', await W.liabilities(db), 'USDT');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
