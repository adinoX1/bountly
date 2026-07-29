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
// 'creator' funded the dare and won nothing. A board that lists everyone who
// ever opened the app is a user list, not a leaderboard — and while it is
// padded with 0-win rows the "nobody has won yet" empty state can never show.
ok(!lb.some(x => x.username === 'creator'), 'somebody with no wins is not on the board');
ok(lb.every(x => x.wins > 0), 'every row on the board has at least one win');
eq(lb.length, 2, 'only the two winners are listed');
// Admins are excluded in JSON mode and used not to be here. The caller passes
// usernames because that is what the ledger keys accounts by.
const lbNoAlice = await W.leaderboard(db, { exclude: ['alice'] });
ok(!lbNoAlice.some(x => x.username === 'alice'), 'an excluded username is left off');
ok(lbNoAlice.some(x => x.username === 'bob'), 'excluding one player keeps the rest');
eq((await W.leaderboard(db, { exclude: [] })).length, 2, 'an empty exclude list drops nobody');
ok((await W.leaderboard(db)).length === 2, 'omitting the option entirely still works');
// ordering is the whole point of a board
const tie = await W.leaderboard(db);
ok(tie[0].wins >= tie[tie.length - 1].wins, 'rows come back ranked by wins');
ok((await W.recentTxns(db, 50)).some(t => t.type === 'payout'), 'ledger txns include payouts');

console.log('\n-- user deposit history (wallet screen) --');
await W.deposit(db, 'diana', 20, 'onchain-d1');
await W.deposit(db, 'diana', 15, 'onchain-d2');
await W.deposit(db, 'diana', 5, 'admin-set:' + crypto.randomUUID());
const dd = await W.userDeposits(db, 'diana');
eq(dd.length, 3, 'diana has three deposits');
eq(dd[0].amount, 5, 'newest deposit first');
eq(dd[0].source, 'admin', 'admin-set deposits are tagged admin');
eq(dd[2].source, 'on-chain', 'a real txhash is tagged on-chain');
ok(dd.every(x => x.amount > 0), 'deposits report a positive amount');
eq((await W.userDeposits(db, 'nobody')).length, 0, 'a user with no deposits gets an empty list');
// creator was funded once (tx1) then posted several dares — only the deposit shows
const cd = await W.userDeposits(db, 'creator');
eq(cd.length, 1, 'funding dares does not add deposit rows');
eq(cd[0].amount, 100, 'only the real deposit is listed');

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

console.log('\n-- dispute / appeal: overturned pays out --');
await W.deposit(db, 'dispA', 100, 'tx-dispA');
const dc = await W.createDare(db, { creatorId: 'dispA', title: 'Contest', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1 });
const cs = await W.submit(db, { dareId: dc.dareId, hunterId: 'harry', vhash: 'har1' });
await W.reject(db, cs.submissionId, 'too dark');
eq((await W.disputeQueue(db)).length, 0, 'nothing disputed yet');
await W.appeal(db, cs.submissionId);
eq((await W.disputeQueue(db)).length, 1, 'appeal lands in the dispute queue');
eq((await W.disputeQueue(db))[0].reason, 'too dark', 'dispute keeps the original reject reason');
await throws(() => W.appeal(db, cs.submissionId), 'a proof can only be appealed once');
ok((await W.listDares(db)).find(d => d.id === dc.dareId).full === false, 'the contested slot is still held');
await W.resolveDispute(db, cs.submissionId, { uphold: false });   // overturn → pay
eq(await W.balance(db, 'harry'), 9, 'overturning the reject pays the hunter 9');
eq((await W.disputeQueue(db)).length, 0, 'dispute cleared');
ok((await W.listDares(db)).find(d => d.id === dc.dareId).full === true, 'slot now filled');

console.log('\n-- dispute / appeal: upheld is final --');
const dc2 = await W.createDare(db, { creatorId: 'dispA', title: 'Contest2', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1 });
const cs2 = await W.submit(db, { dareId: dc2.dareId, hunterId: 'ivan', vhash: 'iv1' });
await W.reject(db, cs2.submissionId, 'not you');
await W.appeal(db, cs2.submissionId);
await W.resolveDispute(db, cs2.submissionId, { uphold: true });
eq(await W.balance(db, 'ivan'), 0, 'upholding the reject pays nothing');
await throws(() => W.appeal(db, cs2.submissionId), 'cannot appeal again after a dispute was upheld');
await throws(() => W.resolveDispute(db, cs2.submissionId, { uphold: false }), 'cannot resolve a dispute that is already closed');

console.log('\n-- appeal guards --');
const dc3 = await W.createDare(db, { creatorId: 'dispA', title: 'Contest3', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1 });
const cs3 = await W.submit(db, { dareId: dc3.dareId, hunterId: 'jane', vhash: 'jn1' });
await throws(() => W.appeal(db, cs3.submissionId), 'a pending proof cannot be appealed');
await W.reject(db, cs3.submissionId, 'blurry');
// the appeal window is enforced from decided_at
await db.query(`UPDATE submissions SET decided_at = now() - interval '3 days' WHERE id=$1`, [cs3.submissionId]);
await throws(() => W.appeal(db, cs3.submissionId), 'appeal is refused after the window closes');
await db.query(`UPDATE submissions SET decided_at = now() WHERE id=$1`, [cs3.submissionId]);
// once the only slot is taken by someone else, there is nothing left to contest
const other = await W.submit(db, { dareId: dc3.dareId, hunterId: 'kyle', vhash: 'ky1' });
await W.approve(db, other.submissionId);
await throws(() => W.appeal(db, cs3.submissionId), 'no appeal once every slot is filled');

console.log('\n-- a disputed proof keeps the dare from expiring --');
const dc4 = await W.createDare(db, { creatorId: 'dispA', title: 'Contest4', desc: 'x', rules: 'y', rewardUsdt: 10, maxWinners: 1, expiresInDays: 7 });
const cs4 = await W.submit(db, { dareId: dc4.dareId, hunterId: 'liam', vhash: 'li1' });
await W.reject(db, cs4.submissionId, 'nope');
await W.appeal(db, cs4.submissionId);
const dc4code = (await W.listDares(db)).find(d => d.id === dc4.dareId).code;
await db.query(`UPDATE dares SET expires_at = now() - interval '1 day' WHERE id=$1`, [dc4.dareId]);
const sw = await W.expireDares(db);
ok(!sw.expired.some(e => e.code === dc4code), 'a dare with a live dispute is not expired');
ok(sw.blocked.some(b => b.code === dc4code), 'it is reported as blocked');
eq((await W.listDares(db)).find(d => d.id === dc4.dareId).status, 'open', 'contested dare stays open');

// ============================================================
// Reactions and comments. The feed used to be one-way: you watched and left.
// Neither of these touches the ledger, and the invariant check at the bottom
// of this file is what proves that.
console.log('\n-- reactions: one per person, tapping twice toggles --');
const rd = (await W.listDares(db))[0];
let rr = await W.react(db, { dareId: rd.id, userId: 'alice', emoji: '🔥' });
eq(rr.total, 1, 'one reaction after one tap');
eq(rr.mine, '🔥', 'and it is remembered as mine');
eq(rr.counts['🔥'], 1, 'counted under the emoji tapped');
// A double-tap on a phone must not become two rows — the primary key decides.
rr = await W.react(db, { dareId: rd.id, userId: 'alice', emoji: '🔥' });
eq(rr.total, 1, 'reacting again does not add a second row');
rr = await W.react(db, { dareId: rd.id, userId: 'alice', emoji: '💀' });
eq(rr.total, 1, 'switching emoji still leaves one reaction');
eq(rr.mine, '💀', 'and mine is the new one');
eq(rr.counts['🔥'], undefined, 'the old emoji drops to zero');
rr = await W.react(db, { dareId: rd.id, userId: 'bob', emoji: '🔥' });
eq(rr.total, 2, 'a second person adds a second reaction');
eq(rr.mine, '🔥', 'the reply reports the reaction of whoever just tapped');
// `mine` is per-viewer, so the same dare answers two people differently.
eq((await W.reactionsFor(db, rd.id, 'bob')).mine, '🔥', 'bob sees bob');
eq((await W.reactionsFor(db, rd.id, 'alice')).mine, '💀', 'alice sees alice');
eq((await W.reactionsFor(db, rd.id, 'stranger')).mine, null, 'a stranger sees nothing of theirs');
eq((await W.reactionsFor(db, rd.id)).total, 2, 'the total is the same for everybody');
rr = await W.react(db, { dareId: rd.id, userId: 'alice', emoji: null });
eq(rr.total, 1, 'clearing removes only mine');
await throws(() => W.react(db, { dareId: rd.id, userId: 'alice', emoji: '🍕' }), 'an emoji outside the set');
await throws(() => W.react(db, { dareId: 99999, userId: 'alice', emoji: '🔥' }), 'reacting to a dare that does not exist');
await throws(() => W.react(db, { dareId: rd.id, userId: '', emoji: '🔥' }), 'reacting as nobody');

console.log('\n-- the feed carries the counts --');
const withCounts = (await W.listDares(db, { viewer: 'bob' })).find(d => d.id === rd.id);
eq(withCounts.reactions, 1, 'listDares reports the reaction count');
eq(withCounts.myReaction, '🔥', 'and what the viewer picked');
eq((await W.listDares(db, { viewer: 'nobody' })).find(d => d.id === rd.id).myReaction, null,
  'somebody who never reacted sees null');
eq((await W.listDares(db)).find(d => d.id === rd.id).myReaction, null, 'no viewer means no opinion');

console.log('\n-- comments --');
const c1 = await W.addComment(db, { dareId: rd.id, userId: 'alice', body: '  this one is  unhinged  ' });
eq(c1.body, 'this one is unhinged', 'whitespace is collapsed, not preserved');
eq(c1.player, 'alice', 'the author is recorded');
ok(c1.at > 0, 'and when');
await W.addComment(db, { dareId: rd.id, userId: 'bob', body: 'doing it tonight' });
eq((await W.commentsFor(db, rd.id)).length, 2, 'both comments come back');
eq((await W.commentsFor(db, rd.id))[0].body, 'this one is unhinged', 'oldest first, like a conversation');
eq((await W.listDares(db)).find(d => d.id === rd.id).comments, 2, 'the feed count keeps up');
await throws(() => W.addComment(db, { dareId: rd.id, userId: 'alice', body: '   ' }), 'an empty comment');
await throws(() => W.addComment(db, { dareId: rd.id, userId: 'alice', body: 'x'.repeat(W.COMMENT_MAX + 1) }), 'a comment over the limit');
await throws(() => W.addComment(db, { dareId: 99999, userId: 'alice', body: 'hello' }), 'commenting on a missing dare');
// Exactly at the limit is allowed — an off-by-one here is a silent annoyance.
ok((await W.addComment(db, { dareId: rd.id, userId: 'carol', body: 'y'.repeat(W.COMMENT_MAX) })).body.length === W.COMMENT_MAX,
  'a comment exactly at the limit is accepted');

console.log('\n-- comments are rate limited --');
// carol already used one of her burst above
for (let i = 0; i < W.COMMENT_BURST - 1; i++) await W.addComment(db, { dareId: rd.id, userId: 'carol', body: 'spam ' + i });
await throws(() => W.addComment(db, { dareId: rd.id, userId: 'carol', body: 'one too many' }), 'the burst limit');
// the limit is per person, not global
ok(await W.addComment(db, { dareId: rd.id, userId: 'dana', body: 'unaffected' }), 'somebody else is not blocked by it');

console.log('\n-- deleting a comment --');
await throws(() => W.deleteComment(db, c1.id, { by: 'bob' }), 'deleting somebody else\'s comment');
ok((await W.deleteComment(db, c1.id, { by: 'alice' })).ok, 'the author can delete their own');
ok(!(await W.commentsFor(db, rd.id)).some(c => c.id === c1.id), 'and it is gone from the list');
// Soft delete: the row survives so a report can still be looked at.
eq((await db.query('SELECT count(*)::int AS n FROM dare_comments WHERE id=$1', [c1.id])).rows[0].n, 1,
  'the row is kept, only flagged');
ok((await W.deleteComment(db, c1.id, { by: 'alice' })).already, 'deleting twice is not an error');
const c2 = await W.addComment(db, { dareId: rd.id, userId: 'bob', body: 'admin will remove this' });
ok((await W.deleteComment(db, c2.id, { by: 'zed', isAdmin: true })).ok, 'an admin can delete anyone\'s');
await throws(() => W.deleteComment(db, 999999, { by: 'alice' }), 'deleting a comment that does not exist');

console.log('\n-- invariants --');
eq(await W.conservation(db), 0, 'everything sums to 0');
ok((await W.reconcile(db)).length === 0, 'cached balances match journal');
console.log('  liabilities:', await W.liabilities(db), 'USDT');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
