import { PGlite } from '@electric-sql/pglite';
import { ledgerApi } from './server_ledger.js';
import * as wallet from './wallet.js';
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

console.log('\n-- auth: admin analytics blocked for non-admin --');
eq((await call('GET','/api/admin/users',{ user:bob })).code,403,'non-admin blocked from /api/admin/users');
eq((await call('GET','/api/admin/users',{ user:admin })).code,200,'admin allowed');

console.log('\n-- invariants --');
eq(await wallet.conservation(pool),0,'conservation 0');
ok((await wallet.reconcile(pool)).length===0,'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
