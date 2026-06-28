// Run with: node test_ledger.mjs
// Uses PGlite (real Postgres in WASM) so the SQL is the same as prod.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import {
  MICRO, deposit, fundDare, submitProof, approveSubmission, rejectSubmission,
  refundDare, withdraw, balanceOf, totalConservation, reconcile, liabilities,
} from './ledger.js';

const U = n => n * MICRO;                 // USDT -> micro-units
let pass = 0, fail = 0;
const ok  = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const eq  = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);
async function throws(fn, m) {
  try { await fn(); fail++; console.log('  ✗ FAIL (no throw):', m); }
  catch (e) { pass++; console.log('  ✓ rejected:', m, '→', e.message); }
}

const db = new PGlite();
await db.exec(readFileSync('./ledger_schema.sql', 'utf8'));

console.log('\n— happy path: fund → approve 2 winners —');
await deposit(db, 'creator', U(100), 'tx_dep1');
eq(await balanceOf(db, 'user', 'creator'), U(100), 'creator funded with 100');

const { dareId } = await fundDare(db, { code: 'BNT-001', creatorId: 'creator', reward: U(10), maxWinners: 2 });
eq(await balanceOf(db, 'user', 'creator'), U(79), 'creator paid 21 (20 escrow + 1 fee)');
eq(await balanceOf(db, 'escrow'), U(20), 'escrow holds 20');
eq(await balanceOf(db, 'platform_fees'), U(1), 'platform took 1 creator fee');

const { submissionId: sA } = await submitProof(db, { dareId, hunterId: 'alice', vhash: 'hashA' });
const { submissionId: sB } = await submitProof(db, { dareId, hunterId: 'bob',   vhash: 'hashB' });
const { submissionId: sC } = await submitProof(db, { dareId, hunterId: 'cara',  vhash: 'hashC' });

await approveSubmission(db, sA);
eq(await balanceOf(db, 'user', 'alice'), U(9), 'alice got 9 (10 - 1 player fee)');
eq(await balanceOf(db, 'escrow'), U(10), 'escrow down to 10');

await approveSubmission(db, sB);
eq(await balanceOf(db, 'user', 'bob'), U(9), 'bob got 9');
eq(await balanceOf(db, 'escrow'), 0, 'escrow empty after both slots paid');
eq(await balanceOf(db, 'platform_fees'), U(3), 'platform fees now 3 (1 + 1 + 1)');

console.log('\n— adversarial: these MUST be rejected —');
await throws(() => approveSubmission(db, sC), 'paying a 3rd winner when only 2 slots');
await throws(() => approveSubmission(db, sA), 'approving the same submission twice');
await throws(() => fundDare(db, { code: 'BNT-X', creatorId: 'creator', reward: U(100), maxWinners: 1 }),
  'funding a dare without enough balance');
await throws(() => withdraw(db, 'alice', U(100), 'tx_w'), 'withdrawing more than balance');
// the rejected fund must have rolled back cleanly
eq(await balanceOf(db, 'user', 'creator'), U(79), 'creator balance unchanged after failed fund');

console.log('\n— refund path: cancel a partly-filled dare —');
const d2 = await fundDare(db, { code: 'BNT-002', creatorId: 'creator', reward: U(10), maxWinners: 3 });
eq(await balanceOf(db, 'user', 'creator'), U(47.5), 'creator paid 31.5 (30 escrow + 1.5 fee) for 3-winner dare');
const { submissionId: s2 } = await submitProof(db, { dareId: d2.dareId, hunterId: 'dan', vhash: 'hashD' });
await approveSubmission(db, s2);
eq(await balanceOf(db, 'escrow'), U(20), 'escrow holds 20 for 2 unpaid slots');
const { refunded } = await refundDare(db, d2.dareId, { cancel: true });
eq(refunded, U(20), 'refunded 20 (2 unpaid slots) to creator');
eq(await balanceOf(db, 'user', 'creator'), U(67.5), 'creator got the refund back');

console.log('\n— system invariants —');
eq(await totalConservation(db), 0, 'all balances sum to 0 (nothing created/destroyed)');
ok((await reconcile(db)).length === 0, 'cached balances match the journal exactly');
// we deposited 100, paid out nothing externally yet → reserve we must hold = liabilities
const liab = await liabilities(db);
console.log('  → current liabilities (must hold on-chain):', liab / MICRO, 'USDT');
ok(liab <= U(100), 'liabilities never exceed the 100 USDT actually deposited');
eq(await balanceOf(db, 'external'), -U(100), 'external mirrors total deposited (−100)');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
