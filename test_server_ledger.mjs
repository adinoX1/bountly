import { PGlite } from '@electric-sql/pglite';
import { ledgerApi } from './server_ledger.js';
import * as wallet from './wallet.js';
import * as deposits from './deposits.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let pass=0, fail=0;
const ok=(c,m)=>{ if(c){pass++;console.log('  ok',m);} else {fail++;console.log('  FAIL',m);} };
const eq=(a,b,m)=>ok(a===b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const pool = new PGlite();
await wallet.initLedger(pool);

// blob holds identity (banned/isAdmin/name); money lives in the ledger
const blob = { users: {
  '1': { id:'1', username:'creator', name:'Creator', isAdmin:true,  banned:false, joinedAt: 3 },
  '2': { id:'2', username:'alice',   name:'Alice',   isAdmin:false, banned:false, joinedAt: 2 },
  '3': { id:'3', username:'bob',     name:'Bob',     isAdmin:false, banned:false, joinedAt: 1 },
} };

async function call(method, p, { user, body, files } = {}) {
  const res = {};
  const json = (r, code, obj) => { res.code = code; res.body = obj; };
  const ctx = { method, path: p, url: new URL('http://x'+p), body, files, user, pool,
    json, notify: () => {}, fs, pathMod: path, crypto, UP_DIR: '/tmp', db: blob, save: () => {} };
  const handled = await ledgerApi(ctx);
  return { handled, code: res.code, body: res.body };
}
const admin = blob.users['1'], alice = blob.users['2'], bob = blob.users['3'];
const dash  = { isAdmin: true, username: '' };   // password-dashboard caller

console.log('\n-- core money flow --');
let r = await call('POST','/api/wallet/deposit',{ user:admin, body:{ username:'creator', usdt:100 } });
eq(r.body.balance,100,'creator deposit 100');
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Ice', desc:'pour', rules:'code', reward:10, maxWinners:2 } });
eq(r.body.code,'BNT-001','create BNT-001');
const dareId = (await call('GET','/api/challenges',{ user:admin })).body.challenges[0].id;
const sA = (await call('POST',`/api/challenges/${dareId}/submit`,{ user:alice, body:{ file:'a.mp4' } })).body.submissionId;
const sB = (await call('POST',`/api/challenges/${dareId}/submit`,{ user:bob, body:{ file:'b.mp4' } })).body.submissionId;
await call('POST',`/api/admin/approve/${sA}`,{ user:admin });
await call('POST',`/api/admin/approve/${sB}`,{ user:admin });
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,9,'alice 9 after payout');

console.log('\n-- dashboard: overview --');
r = await call('GET','/api/dash/overview',{ user:dash });
eq(r.body.overview.users,3,'overview users=3');
eq(r.body.overview.challenges,1,'overview challenges=1');
eq(r.body.overview.approved,2,'overview approved=2');
eq(r.body.overview.paidOut,18,'overview paidOut=18 (2x9)');
ok(r.body.overview.charts && r.body.overview.charts.activity.labels.length===14,'14-day activity chart present');

console.log('\n-- dashboard: users --');
r = await call('GET','/api/dash/users',{ user:dash });
eq(r.body.users.length,3,'3 users listed');
const aliceRow = r.body.users.find(u=>u.username==='alice');
eq(aliceRow.credits,9,'alice credits 9'); eq(aliceRow.earned,9,'alice earned 9'); eq(aliceRow.wins,1,'alice wins 1');

console.log('\n-- dashboard: txns + challenges --');
ok((await call('GET','/api/dash/txns',{ user:dash })).body.txns.some(t=>t.type==='payout'),'txns include payout (from/to/amount)');
eq((await call('GET','/api/dash/challenges',{ user:dash })).body.challenges.length,1,'dash challenges=1');

console.log('\n-- dashboard: ban + set credits --');
r = await call('POST','/api/dash/ban/2',{ user:dash });
eq(r.body.banned,true,'alice banned'); eq(blob.users['2'].banned,true,'blob reflects ban');
r = await call('POST','/api/dash/credits/2',{ user:dash, body:{ credits:50 } });
eq(r.body.credits,50,'set credits returns 50');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,50,'alice balance now 50 via ledger');

console.log('\n-- set credits works more than once (constant admin-set ref bug) --');
r = await call('POST','/api/dash/credits/2',{ user:dash, body:{ credits:70 } });
eq(r.code,200,'second raise succeeds');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,70,'alice now 70');
r = await call('POST','/api/dash/credits/2',{ user:dash, body:{ credits:60 } });
eq(r.code,200,'lowering credits succeeds');
r = await call('POST','/api/dash/credits/2',{ user:dash, body:{ credits:80 } });
eq(r.code,200,'third raise still succeeds');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,80,'alice now 80');

console.log('\n-- withdraw is admin-only and needs a txhash --');
eq((await call('POST','/api/wallet/withdraw',{ user:bob, body:{ usdt:5 } })).code,403,'user cannot withdraw');
eq((await call('POST','/api/wallet/withdraw',{ user:admin, body:{ usdt:5 } })).code,400,'admin still needs a txhash');
r = await call('POST','/api/wallet/withdraw',{ user:admin, body:{ usdt:5, username:'alice', txhash:'onchain-1' } });
eq(r.code,200,'admin records a settled send');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,75,'alice debited to 75');
r = await call('POST','/api/wallet/withdraw',{ user:admin, body:{ usdt:5, username:'alice', txhash:'onchain-1' } });
eq(r.code,400,'the same txhash cannot be recorded twice');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,75,'alice not double-debited');

console.log('\n-- submit guards in LEDGER mode --');
// alice is banned by now, so use a fresh hunter to reach the slot checks
blob.users['4'] = { id:'4', username:'carol', name:'Carol', isAdmin:false, banned:false, joinedAt: 0 };
const carol = blob.users['4'];
eq((await call('POST',`/api/challenges/${dareId}/submit`,{ user:carol, body:{ file:'x.mp4' } })).code,400,'filled dare rejects new proofs');
eq((await call('POST',`/api/challenges/${dareId}/submit`,{ user:alice, body:{ file:'x.mp4' } })).code,403,'banned hunter is refused');
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Solo', desc:'d', rules:'r', reward:5, maxWinners:1 } });
const solo = (await call('GET','/api/challenges',{ user:admin })).body.challenges.find(c=>c.code===r.body.code).id;
eq((await call('POST',`/api/challenges/${solo}/submit`,{ user:admin, body:{ file:'own.mp4' } })).code,403,"creator can't submit to their own dare");
eq((await call('POST',`/api/challenges/${solo}/submit`,{ user:bob, body:{ file:'b1.mp4' } })).code,200,'bob submits');
eq((await call('POST',`/api/challenges/${solo}/submit`,{ user:bob, body:{ file:'b2.mp4' } })).code,400,'bob cannot double-submit');

console.log('\n-- edit is handled in LEDGER mode (used to hit the dead JSON blob) --');
r = await call('POST',`/api/admin/challenge/${solo}/edit`,{ user:admin, body:{ title:'Renamed solo' } });
eq(r.code,200,'edit accepted');
eq((await call('GET','/api/challenges',{ user:admin })).body.challenges.find(c=>c.id===solo).title,'Renamed solo','title actually changed in the ledger');
eq((await call('POST',`/api/admin/challenge/${solo}/edit`,{ user:bob, body:{ title:'x' } })).code,403,'non-admin cannot edit');

console.log('\n-- dispute flow through the API --');
// fresh dare; bob submits, admin rejects, bob appeals, admin overturns → bob paid
await call('POST','/api/wallet/deposit',{ user:admin, body:{ username:'creator', usdt:50 } });
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Disputed', desc:'d', rules:'r', reward:10, maxWinners:1 } });
const dispCode = r.body.code;
const dispId = (await call('GET','/api/challenges',{ user:admin })).body.challenges.find(c=>c.code===dispCode).id;
const dsub = (await call('POST',`/api/challenges/${dispId}/submit`,{ user:bob, body:{ file:'d.mp4' } })).body.submissionId;
eq((await call('POST',`/api/admin/reject/${dsub}`,{ user:admin, body:{ reason:'too dark' } })).code,200,'admin rejects');
let act = await call('GET','/api/me/activity',{ user:bob });
eq(act.body.submissions.find(s=>s.id===dsub).canAppeal,true,'a fresh rejection is appealable');
eq((await call('POST',`/api/submissions/${dsub}/appeal`,{ user:alice })).code,403,'only the owner can appeal');
eq((await call('POST',`/api/submissions/${dsub}/appeal`,{ user:bob })).code,200,'owner appeals');
eq((await call('POST',`/api/submissions/${dsub}/appeal`,{ user:bob })).code,400,'cannot appeal twice');
eq((await call('GET','/api/admin/disputes',{ user:bob })).code,403,'non-admin cannot see the dispute queue');
let dq = await call('GET','/api/admin/disputes',{ user:admin });
eq(dq.body.disputes.length,1,'dispute queue has the appeal');
eq(dq.body.disputes[0].reason,'too dark','queue shows the contested reason');
const bobBefore = (await call('GET','/api/me',{ user:bob })).body.user.credits;
eq((await call('POST',`/api/admin/dispute/${dsub}/resolve`,{ user:admin, body:{ uphold:false } })).code,200,'admin overturns');
eq((await call('GET','/api/me',{ user:bob })).body.user.credits, bobBefore+9,'bob paid 9 on the overturn');
eq((await call('GET','/api/admin/disputes',{ user:admin })).body.disputes.length,0,'dispute queue cleared');

console.log('\n-- dispute upheld is final --');
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Disputed2', desc:'d', rules:'r', reward:10, maxWinners:1 } });
const d2Id = (await call('GET','/api/challenges',{ user:admin })).body.challenges.find(c=>c.code===r.body.code).id;
const d2sub = (await call('POST',`/api/challenges/${d2Id}/submit`,{ user:bob, body:{ file:'d2.mp4' } })).body.submissionId;
await call('POST',`/api/admin/reject/${d2sub}`,{ user:admin, body:{ reason:'nope' } });
await call('POST',`/api/submissions/${d2sub}/appeal`,{ user:bob });
const bobBefore2 = (await call('GET','/api/me',{ user:bob })).body.user.credits;
eq((await call('POST',`/api/admin/dispute/${d2sub}/resolve`,{ user:admin, body:{ uphold:true } })).code,200,'admin upholds');
eq((await call('GET','/api/me',{ user:bob })).body.user.credits, bobBefore2,'no payout when the reject is upheld');
act = await call('GET','/api/me/activity',{ user:bob });
eq(act.body.submissions.find(s=>s.id===d2sub).status,'rejected','upheld dispute ends rejected');
eq(act.body.submissions.find(s=>s.id===d2sub).canAppeal,false,'cannot appeal a second time');

console.log('\n-- auth: admin analytics blocked for non-admin --');
eq((await call('GET','/api/admin/users',{ user:bob })).code,403,'non-admin blocked from /api/admin/users');
eq((await call('GET','/api/admin/users',{ user:admin })).code,200,'admin allowed');

console.log('\n-- health endpoint --');
r = await call('GET','/api/admin/health',{ user:admin });
eq(r.code,200,'health is 200 while the books balance');
eq(r.body.health.ok,true,'health ok');
eq(r.body.health.conservation,0,'conservation 0');
eq(r.body.health.drift.length,0,'no drift between cache and journal');
eq(r.body.health.escrowMatches,true,'escrow account equals the sum of dares.escrow_locked');
eq((await call('GET','/api/admin/health',{ user:bob })).code,403,'non-admin blocked from health');

console.log('\n-- health catches a tampered balance --');
await pool.query(`UPDATE accounts SET balance = balance + 1000 WHERE kind='user' AND owner_id='bob'`);
r = await call('GET','/api/admin/health',{ user:admin });
eq(r.code,500,'health reports 500 after a manual balance edit');
eq(r.body.health.ok,false,'health not ok');
ok(r.body.health.drift.some(d=>d.owner==='bob'),'drift names the tampered account');
await pool.query(`UPDATE accounts SET balance = balance - 1000 WHERE kind='user' AND owner_id='bob'`);

console.log('\n-- a bounty is whole dollars, and says so --');
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Cents', desc:'x', rules:'y', reward:7.5, maxWinners:1 } });
eq(r.code,400,'a fractional bounty is refused, not silently floored');
ok(/whole dollars/.test(r.body.error),'the message explains why');
ok(/\$7\b/.test(r.body.error) && /\$8\b/.test(r.body.error),'and offers both neighbours');
eq((await call('POST','/api/challenges',{ user:admin, body:{ title:'Whole', desc:'x', rules:'y', reward:7, maxWinners:1 } })).code,200,'a whole-dollar bounty still posts');

console.log('\n-- an overspend reports the shortfall as money --');
r = await call('POST','/api/challenges',{ user:bob, body:{ title:'Too rich', desc:'x', rules:'y', reward:9999, maxWinners:1 } });
eq(r.code,400,'the ledger refuses it');
ok(/insufficient funds/.test(r.body.error),'it is an insufficient-funds error');
ok(/\$[\d.]+ short/.test(r.body.error),'the shortfall is stated in dollars');
ok(!/\d{7}/.test(r.body.error),'no raw micro-units leak to the player');

console.log('\n-- in-flight deposits are visible to their owner only --');
const beforeSighting = (await call('GET','/api/me',{ user:alice })).body.user.credits;
await deposits.noteSeen(pool,{ chain:'ton', txref:'live-1', username:'alice', amountUsdt:25, confirms:1, need:3 });
r = await call('GET','/api/wallet/pending',{ user:alice });
eq(r.code,200,'pending endpoint answers');
eq(r.body.pending.length,1,'alice sees her transfer confirming');
eq(r.body.pending[0].amount,25,'with the amount spotted on-chain');
eq(r.body.pending[0].confirms,1,'and how far along it is');
eq(r.body.pending[0].need,3,'and what it needs');
ok(r.body.pending[0].text.includes('1 of 3'),'the server phrases the progress');
eq((await call('GET','/api/wallet/pending',{ user:bob })).body.pending.length,0,'bob sees nothing of it');
eq((await call('GET','/api/me',{ user:alice })).body.user.credits,beforeSighting,'a pending transfer moves no credits');

console.log('\n-- scanning is throttled per player --');
r = await call('POST','/api/wallet/scan',{ user:alice, body:{} });
eq(r.code,200,'a scan is accepted');
eq(r.body.scanned,true,'the first one runs');
eq((await call('POST','/api/wallet/scan',{ user:alice, body:{} })).body.scanned,false,'an immediate second one is refused');
eq((await call('POST','/api/wallet/scan',{ user:bob, body:{} })).body.scanned,true,'another player is unaffected');

console.log('\n-- invariants --');
eq(await wallet.conservation(pool),0,'conservation 0');
ok((await wallet.reconcile(pool)).length===0,'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
