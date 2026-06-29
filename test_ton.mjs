import { PGlite } from '@electric-sql/pglite';
import * as wallet from './wallet.js';
import { creditConfirmedDeposit, decodeComment } from './ton.js';

let pass=0, fail=0;
const eq=(a,b,m)=>{ if(a===b){pass++;console.log('  ok',m);} else {fail++;console.log(`  FAIL ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);} };
const ok=(c,m)=>{ if(c){pass++;console.log('  ok',m);} else {fail++;console.log('  FAIL',m);} };

const pool = new PGlite();
await wallet.initLedger(pool);

console.log('\n-- idempotent deposit credit --');
let r = await creditConfirmedDeposit(pool, { txhash:'tx_aaa', username:'alice', amountUsdt:50 });
eq(r.credited, true, 'first credit applied');
eq(await wallet.balance(pool,'alice'), 50, 'alice balance 50');

r = await creditConfirmedDeposit(pool, { txhash:'tx_aaa', username:'alice', amountUsdt:50 });
eq(r.credited, false, 'same tx hash NOT credited again');
eq(await wallet.balance(pool,'alice'), 50, 'alice balance still 50 (no double credit)');

r = await creditConfirmedDeposit(pool, { txhash:'tx_bbb', username:'alice', amountUsdt:25 });
eq(r.credited, true, 'different tx credited');
eq(await wallet.balance(pool,'alice'), 75, 'alice balance 75');

console.log('\n-- comment decode (username from on-chain memo) --');
const cell = Buffer.concat([Buffer.from([0,0,0,0]), Buffer.from('bob','utf8')]).toString('base64');
eq(decodeComment(cell), 'bob', 'decodes 4-byte-prefixed text comment');
eq(decodeComment(Buffer.from('carol','utf8').toString('base64')), 'carol', 'decodes plain text comment');
eq(decodeComment(''), '', 'empty -> empty');

console.log('\n-- invariants --');
eq(await wallet.conservation(pool), 0, 'conservation 0');
ok((await wallet.reconcile(pool)).length===0, 'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
