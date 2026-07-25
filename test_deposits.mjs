// Run with: node test_deposits.mjs
// The confirmation tracker decides WHEN an on-chain transfer becomes money.
// Everything here runs offline: the chain reads are injected as fakes, so the
// rule "credit only what a fresh read says is final" is tested rather than
// hoped for.
import { PGlite } from '@electric-sql/pglite';
import * as wallet from './wallet.js';
import * as D from './deposits.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL', m); } };

const pool = new PGlite();
await wallet.initLedger(pool);

// ============================================================
console.log('\n-- TON: confirmations are masterchain depth --');
eq(D.tonConfirms(100, 100), 1, 'in the head block counts as one confirmation');
eq(D.tonConfirms(100, 103), 4, 'three blocks later = four confirmations');
eq(D.tonConfirms(100, 99), 0, 'head behind the tx (indexer lag) = zero, never negative');
eq(D.tonConfirms(0, 500), 0, 'unknown block = zero');
eq(D.tonConfirms(100, 0), 0, 'unknown head = zero');

console.log('\n-- Solana: the cluster answers directly --');
eq(D.solConfirms({ confirmationStatus: 'finalized' }).confirms, D.SOL_NEED, 'finalized reaches the bar');
eq(D.solConfirms({ confirmationStatus: 'confirmed', confirmations: 5 }).confirms, 5, 'confirmed reports its depth');
ok(D.solConfirms({ confirmationStatus: 'confirmed', confirmations: 900 }).confirms < D.SOL_NEED,
  'a confirmed-but-not-final tx can never reach the bar, however deep');
eq(D.solConfirms({ err: { some: 'error' } }).failed, true, 'a failed tx is failed, not pending');
eq(D.solConfirms(null).seen, false, 'no status = not seen yet');

console.log('\n-- the verdict for one fresh read --');
eq(D.verdict({ seen: true, failed: false, confirms: 3, need: 1 }), 'confirmable', 'deep enough → pay');
eq(D.verdict({ seen: true, failed: false, confirms: 0, need: 1 }), 'confirming', 'seen but shallow → wait');
eq(D.verdict({ seen: false, failed: false, confirms: 0, need: 1 }), 'unseen', 'not on-chain → unseen');
eq(D.verdict({ seen: true, failed: true, confirms: 9, need: 1 }), 'failed', 'a failed tx is never payable, however deep');

console.log('\n-- staleness --');
ok(!D.isStale(Date.now() - 60e3), 'a minute old is not stale');
ok(D.isStale(Date.now() - D.STALE_MS - 1000), 'past the window it is');

// ============================================================
console.log('\n-- watching a sighting --');
await D.noteSeen(pool, { chain: 'ton', txref: 'tx1', username: 'alice', amountUsdt: 25, confirms: 0, need: 3 });
let pend = await D.pendingFor(pool, 'alice');
eq(pend.length, 1, 'alice sees one transfer in flight');
eq(pend[0].amountUsdt, 25, 'with the amount we spotted');
eq(pend[0].confirms, 0, 'no confirmations yet');
eq(await wallet.balance(pool, 'alice'), 0, 'a sighting is NOT money');

await D.noteSeen(pool, { chain: 'ton', txref: 'tx1', username: 'alice', amountUsdt: 25, confirms: 2, need: 3 });
pend = await D.pendingFor(pool, 'alice');
eq(pend.length, 1, 'seeing it again does not duplicate the row');
eq(pend[0].confirms, 2, 'it just refreshes the confirmation count');

eq((await D.pendingFor(pool, 'bob')).length, 0, 'another player sees nothing of it');

console.log('\n-- what the sheet prints --');
ok(D.progressText({ status: 'seen', confirms: 0, need: 3, amountUsdt: 25 }).includes('first confirmation'),
  'zero confirmations reads as waiting for the first');
ok(D.progressText({ status: 'seen', confirms: 2, need: 3, amountUsdt: 25 }).includes('2 of 3'),
  'progress is stated plainly');

// ============================================================
console.log('\n-- the confirmation pass --');
// A fake chain we can move forward by hand.
const chain = { tx1: { seen: true, failed: false, confirms: 2 } };
const credits = [];
const readers = {
  ton: {
    status: async ref => chain[ref] || { seen: false, failed: false, confirms: 0 },
    credit: async ({ txref, username, amountUsdt }) => {
      credits.push(txref);
      return wallet.withClient(pool, c => wallet.deposit(c, username, amountUsdt, txref))
        .then(() => ({ credited: true }));
    },
  },
};

let r = await D.confirmOpen(pool, readers);
eq(r.confirming, 1, 'two of three confirmations → still confirming');
eq(r.credited, 0, 'nothing credited yet');
eq(await wallet.balance(pool, 'alice'), 0, 'balance untouched while it confirms');
eq((await D.pendingFor(pool, 'alice'))[0].confirms, 2, 'the count is written back for the UI');

chain.tx1.confirms = 3;
r = await D.confirmOpen(pool, readers);
eq(r.credited, 1, 'at the bar it credits');
eq(await wallet.balance(pool, 'alice'), 25, 'alice now has the money');
eq(credits.length, 1, 'the chain was read once to pay');

r = await D.confirmOpen(pool, readers);
eq(r.checked, 0, 'the settled row is out of the queue');
eq(credits.length, 1, 'and is never paid a second time');
eq(await wallet.balance(pool, 'alice'), 25, 'balance still 25');

console.log('\n-- a transfer that fails on-chain --');
await D.noteSeen(pool, { chain: 'ton', txref: 'txbad', username: 'bob', amountUsdt: 40, confirms: 0, need: 1 });
chain.txbad = { seen: true, failed: true, confirms: 0, detail: 'transaction aborted on-chain' };
r = await D.confirmOpen(pool, readers);
eq(r.failed, 1, 'it is closed as failed');
eq(await wallet.balance(pool, 'bob'), 0, 'bob is not credited');
const bobRows = await D.pendingFor(pool, 'bob');
eq(bobRows[0].status, 'failed', 'and bob is told why');
ok(bobRows[0].detail.includes('aborted'), 'with the chain\'s own reason');

console.log('\n-- a sighting the chain never confirms --');
await D.noteSeen(pool, { chain: 'ton', txref: 'txghost', username: 'carol', amountUsdt: 10, confirms: 0, need: 1 });
r = await D.confirmOpen(pool, readers);   // txghost is not in `chain` → unseen
eq(r.confirming, 1, 'inside the window it keeps waiting');
r = await D.confirmOpen(pool, readers, { now: Date.now() + D.STALE_MS + 1000 });
eq(r.failed, 1, 'past the window it is closed out');
eq(await wallet.balance(pool, 'carol'), 0, 'carol was never credited');

console.log('\n-- the credit path can veto a sighting --');
await D.noteSeen(pool, { chain: 'ton', txref: 'txmismatch', username: 'dave', amountUsdt: 999, confirms: 5, need: 1 });
const vetoReaders = { ton: { status: async () => ({ seen: true, failed: false, confirms: 5 }),
  credit: async () => ({ credited: false, reason: 'on-chain transfer does not match what we saw' }) } };
r = await D.confirmOpen(pool, vetoReaders);
eq(r.failed, 1, 'a disagreement between sighting and chain pays nothing');
eq(await wallet.balance(pool, 'dave'), 0, 'dave gets nothing');

console.log('\n-- an already-credited transfer is not re-watched --');
await wallet.withClient(pool, c => wallet.deposit(c, 'erin', 12, 'txpaid'));
const w = await D.noteSeen(pool, { chain: 'sol', txref: 'txpaid', username: 'erin', amountUsdt: 12 });
eq(w.watched, false, 'noteSeen refuses a ref the ledger already has');
eq((await D.pendingFor(pool, 'erin')).length, 0, 'erin sees no phantom pending deposit');
eq(await wallet.balance(pool, 'erin'), 12, 'her balance is just the credit');

console.log('\n-- two chains do not collide on the same ref --');
await D.noteSeen(pool, { chain: 'ton', txref: 'shared', username: 'frank', amountUsdt: 5, need: 1 });
await D.noteSeen(pool, { chain: 'sol', txref: 'shared', username: 'frank', amountUsdt: 7, need: 1 });
eq((await D.pendingFor(pool, 'frank')).length, 2, 'the same string on two chains is two sightings');

console.log('\n-- expireStale sweeps abandoned sightings --');
const n = await D.expireStale(pool, { now: Date.now() + D.STALE_MS + 1000 });
ok(n >= 2, 'the open frank rows are swept');
eq((await D.pendingFor(pool, 'frank')).filter(x => x.status === 'seen').length, 0, 'nothing of frank\'s is still spinning');

console.log('\n-- the ledger survived all of it --');
eq(await wallet.conservation(pool), 0, 'conservation 0');
ok((await wallet.reconcile(pool)).length === 0, 'reconcile clean');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
