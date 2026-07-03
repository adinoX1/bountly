// Run: node test_solana.mjs   (no network, no Solana libs needed)
import { usdcCredited, evaluateDeposit, webhookAuthorized } from './solana.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };

const OWNER = 'USERdepositADDR', MINT = 'USDCmint111', DEC = 6, MIN = 0.5;
const bal = (accountIndex, amount, mint = MINT, owner = OWNER, decimals = DEC) =>
  ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals } });
const mk = (pre, post, err = null) => ({ meta: { err, preTokenBalances: pre, postTokenBalances: post } });

console.log('\n-- usdcCredited (pure) --');
eq(usdcCredited([bal(1, 0)], [bal(1, 2_000_000)], { owner: OWNER, mint: MINT, decimals: DEC }), 2, 'fresh 2 USDC credited');
eq(usdcCredited([bal(1, 1_000_000)], [bal(1, 3_000_000)], { owner: OWNER, mint: MINT, decimals: DEC }), 2, 'counts only the +2 delta, not the pre-balance');
eq(usdcCredited([], [bal(1, 2_000_000, 'FAKEmint')], { owner: OWNER, mint: MINT, decimals: DEC }), 0, 'fake look-alike mint ignored');
eq(usdcCredited([], [bal(1, 2_000_000, MINT, 'SOMEONE_ELSE')], { owner: OWNER, mint: MINT, decimals: DEC }), 0, 'credit to a different owner ignored');
eq(usdcCredited([], [bal(1, 2_000_000, MINT, OWNER, 9)], { owner: OWNER, mint: MINT, decimals: DEC }), 0, 'wrong decimals ignored');
eq(usdcCredited([bal(1, 5_000_000)], [bal(1, 1_000_000)], { owner: OWNER, mint: MINT, decimals: DEC }), 0, 'outbound (negative delta) not credited');

console.log('\n-- evaluateDeposit --');
eq(evaluateDeposit(mk([bal(1, 0)], [bal(1, 2_000_000)]), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).credit, true, 'valid 2 USDC → credit');
eq(evaluateDeposit(mk([bal(1, 0)], [bal(1, 2_000_000)]), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).amount, 2, 'amount = 2');
eq(evaluateDeposit(mk([bal(1, 0)], [bal(1, 100_000)]), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).reason, 'below minimum', '0.1 USDC below minimum');
eq(evaluateDeposit(mk([bal(1, 0)], [bal(1, 2_000_000)], 'InstructionError'), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).credit, false, 'failed tx not credited');
eq(evaluateDeposit(mk([bal(1, 0)], [bal(1, 2_000_000)]), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN, finalized: false }).credit, false, 'unfinalized not credited');
eq(evaluateDeposit(null, { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).credit, false, 'null tx not credited');
eq(evaluateDeposit(mk([], [bal(1, 2_000_000, 'FAKEmint')]), { owner: OWNER, mint: MINT, decimals: DEC, min: MIN }).credit, false, 'fake mint tx not credited');

console.log('\n-- webhookAuthorized --');
ok(webhookAuthorized({ authorization: 'sekret' }, 'sekret'), 'matching secret authorized');
ok(!webhookAuthorized({ authorization: 'wrong' }, 'sekret'), 'wrong secret rejected');
ok(!webhookAuthorized({}, ''), 'no configured secret → fail closed');
ok(!webhookAuthorized({}, 'sekret'), 'missing header rejected');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
