// Run with: node test_migrate.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { migrateAppState } from './migrate_to_ledger.mjs';
import { MICRO, balanceOf, totalConservation, reconcile, approveSubmission, refundDare } from './ledger.js';

const U = n => n * MICRO;
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ✓', m); } else { fail++; console.log(`  ✗ FAIL: ${m} (got ${a}, want ${b})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
async function throws(fn, m) { try { await fn(); fail++; console.log('  ✗ FAIL (no throw):', m); } catch (e) { pass++; console.log('  ✓ rejected:', m); } }

// a realistic snapshot of the old JSON app_state
const appState = {
  users: {
    100: { id: 100, username: 'creator', credits: 48, wins: 0 },
    200: { id: 200, username: 'alice',   credits: 9,  wins: 1 },
    300: { id: 300, username: 'bob',     credits: 9,  wins: 1 },
    400: { id: 400, username: 'dan',     credits: 9,  wins: 1 },
    500: { id: 500, username: 'eve',     credits: 0,  wins: 0 },
  },
  challenges: [
    { id: 1, code: 'BNT-001', title: 'Ice bucket', reward: 10, maxWinners: 2, creator: 'creator', createdAt: Date.now() - 7200e3 },
    { id: 2, code: 'BNT-002', title: 'Sing',       reward: 10, maxWinners: 3, creator: 'creator', createdAt: Date.now() - 3600e3 },
  ],
  submissions: [
    { id: 1, chId: 1, player: 'alice', userId: 200, status: 'approved', vhash: 'a', at: Date.now() - 7000e3 },
    { id: 2, chId: 1, player: 'bob',   userId: 300, status: 'approved', vhash: 'b', at: Date.now() - 6900e3 },
    { id: 3, chId: 2, player: 'dan',   userId: 400, status: 'approved', vhash: 'd', at: Date.now() - 3000e3 },
    { id: 4, chId: 2, player: 'eve',   userId: 500, status: 'pending',  vhash: 'e', at: Date.now() - 1000e3 },
  ],
  txns: [
    { type: 'fee', amount: 1 }, { type: 'commission', amount: 1 },
    { type: 'commission', amount: 1 }, { type: 'fee', amount: 1.5 },
  ],
};

const db = new PGlite();
await db.exec(readFileSync('./ledger_schema.sql', 'utf8'));

console.log('\n— run migration —');
const res = await migrateAppState(db, appState);
console.log('  migration result:', res);

console.log('\n— balances carried over exactly —');
eq(await balanceOf(db, 'user', '100'), U(48), 'creator credits -> balance');
eq(await balanceOf(db, 'user', '200'), U(9),  'alice credits -> balance');
eq(await balanceOf(db, 'user', '400'), U(9),  'dan credits -> balance');
eq(await balanceOf(db, 'escrow'), U(20), 'escrow = 2 unpaid slots of BNT-002 (2 x 10)');
eq(await balanceOf(db, 'platform_fees'), U(4.5), 'historical fees 1+1+1+1.5 = 4.5');

console.log('\n— structural checks —');
const d = await db.query(`SELECT code, status, escrow_locked FROM dares ORDER BY code`);
ok(d.rows.find(x => x.code === 'BNT-001').status === 'closed', 'BNT-001 fully paid -> closed');
ok(d.rows.find(x => x.code === 'BNT-002').status === 'open', 'BNT-002 has slots -> open');
eq(Number(d.rows.find(x => x.code === 'BNT-002').escrow_locked), U(20), 'BNT-002 escrow_locked = 20');

console.log('\n— invariants —');
eq(await totalConservation(db), 0, 'everything sums to 0');
ok((await reconcile(db)).length === 0, 'cached balances == journal');

console.log('\n— migrated state is immediately usable —');
const eve = await db.query(`SELECT s.id FROM submissions s JOIN dares d ON d.id=s.dare_id WHERE d.code='BNT-002' AND s.hunter_id='500'`);
await approveSubmission(db, Number(eve.rows[0].id));
eq(await balanceOf(db, 'user', '500'), U(9), 'eve paid 9 from migrated escrow');
eq(await balanceOf(db, 'escrow'), U(10), 'escrow down to 10');
const ref = await refundDare(db, (await db.query(`SELECT id FROM dares WHERE code='BNT-002'`)).rows[0].id);
eq(ref.refunded, U(10), 'refunded last unpaid slot (10) to creator');
eq(await balanceOf(db, 'user', '100'), U(58), 'creator 48 + 10 refund = 58');
eq(await totalConservation(db), 0, 'still balanced after approve + refund');

console.log('\n— migration refuses to run twice —');
await throws(() => migrateAppState(db, appState), 'second migration run blocked');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
