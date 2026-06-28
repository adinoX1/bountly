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

async function call(method, p, { user, body, files } = {}) {
  const res = {};
  const json = (r, code, obj) => { res.code = code; res.body = obj; };
  const ctx = { method, path: p, url: new URL('http://x'+p), body, files, user, pool,
    json, notify: () => {}, fs, pathMod: path, crypto, UP_DIR: '/tmp' };
  const handled = await ledgerApi(ctx);
  return { handled, code: res.code, body: res.body };
}
const admin = { id:'1', username:'creator', name:'Creator', isAdmin:true, banned:false };
const alice = { id:'2', username:'alice', name:'Alice', isAdmin:false, banned:false };
const bob   = { id:'3', username:'bob',   name:'Bob',   isAdmin:false, banned:false };

console.log('\n-- deposit + me --');
let r = await call('POST','/api/wallet/deposit',{ user:admin, body:{ username:'creator', usdt:100 } });
eq(r.code,200,'deposit ok'); eq(r.body.balance,100,'creator balance 100');
r = await call('GET','/api/me',{ user:admin });
eq(r.body.user.credits,100,'/api/me shows 100');

console.log('\n-- create + list --');
r = await call('POST','/api/challenges',{ user:admin, body:{ title:'Ice', desc:'pour', rules:'say code', reward:10, maxWinners:2 } });
eq(r.code,200,'create ok'); eq(r.body.code,'BNT-001','code BNT-001');
r = await call('GET','/api/challenges',{ user:admin });
eq(r.body.challenges.length,1,'one challenge listed');
eq(r.body.challenges[0].title,'Ice','title shown');
const dareId = r.body.challenges[0].id;

console.log('\n-- submit (alice, bob) --');
r = await call('POST',`/api/challenges/${dareId}/submit`,{ user:alice, body:{ file:'a.mp4' } });
eq(r.code,200,'alice submit ok'); const sA=r.body.submissionId;
r = await call('POST',`/api/challenges/${dareId}/submit`,{ user:bob, body:{ file:'b.mp4' } });
const sB=r.body.submissionId;
r = await call('POST',`/api/challenges/${dareId}/submit`,{ user:admin, body:{ file:'x.mp4' } });
eq(r.code,403,"creator can't do own dare");

console.log('\n-- admin queue + approve --');
r = await call('GET','/api/admin/queue',{ user:admin });
eq(r.body.queue.length,2,'queue has 2');
r = await call('GET','/api/admin/queue',{ user:alice });
eq(r.code,403,'non-admin blocked from queue');
r = await call('POST',`/api/admin/approve/${sA}`,{ user:admin });
eq(r.code,200,'approve alice ok');
r = await call('GET','/api/me',{ user:alice });
eq(r.body.user.credits,9,'alice balance 9 after payout');

console.log('\n-- leaderboard --');
r = await call('GET','/api/leaderboard',{ user:admin });
ok(r.body.leaderboard.find(x=>x.username==='alice' && x.wins===1 && x.earned===9),'leaderboard alice 1/9');

console.log('\n-- approve bob fills, third rejected at submit --');
await call('POST',`/api/admin/approve/${sB}`,{ user:admin });
r = await call('POST',`/api/challenges/${dareId}/submit`,{ user:alice, body:{ file:'late.mp4' } });
ok(r.code===400 || r.code===403,'submit to filled/closed dare rejected');

console.log('\n-- invariants --');
eq(await wallet.conservation(pool),0,'conservation 0');
ok((await wallet.reconcile(pool)).length===0,'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
