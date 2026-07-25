import { PGlite } from '@electric-sql/pglite';
import * as wallet from './wallet.js';
import { creditConfirmedDeposit, decodeComment, transferFields } from './ton.js';

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

console.log('\n-- reading a toncenter transfer row --');
const memo = Buffer.concat([Buffer.from([0,0,0,0]), Buffer.from('dora','utf8')]).toString('base64');
let f = transferFields({ transaction_hash:'H1', forward_payload:memo, amount:'2500000', mc_block_seqno:900 }, 6);
eq(f.username, 'dora', 'username comes from the memo');
eq(f.amountUsdt, 2.5, 'raw jetton units are scaled by the decimals');
eq(f.seqno, 900, 'the masterchain seqno is carried through for the confirmation count');
f = transferFields({ trace_id:'H2', comment:'ed', amount:'1000000', masterchain_seqno:12 }, 6);
eq(f.txhash, 'H2', 'falls back to trace_id when there is no transaction_hash');
eq(f.seqno, 12, 'and to masterchain_seqno for the block');
ok(!transferFields({ transaction_hash:'H3', amount:'1000000' }, 6), 'no memo → no user to credit → skipped');
ok(!transferFields({ transaction_hash:'H4', comment:'ed', amount:'0' }, 6), 'zero amount → skipped');
ok(!transferFields(null, 6), 'garbage → skipped, not thrown');

console.log('\n-- invariants --');
eq(await wallet.conservation(pool), 0, 'conservation 0');
ok((await wallet.reconcile(pool)).length===0, 'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
