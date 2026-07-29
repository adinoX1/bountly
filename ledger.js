// ============================================================
// BOUNTLY — escrow ledger + dare state machine
//
// Every money movement goes through postTx(), which:
//   1. locks the involved accounts (SELECT ... FOR UPDATE) so two
//      requests can't race on the same balance,
//   2. refuses any transaction whose entries don't sum to exactly 0
//      (money can't be created or destroyed),
//   3. refuses to let a `user` or `escrow` balance go negative
//      (no overdraw, no spending escrow you don't have).
//
// Because of (2)+(3), the dangerous moves are impossible by
// construction: you can't pay a winner more than the dare locked,
// you can't pay the same slot twice past the locked amount, and you
// can't fund a dare without the credits.
//
// `db` is anything with async .query(text, params) -> { rows }.
// Works with node-postgres (pg) in prod and PGlite in tests.
// IMPORTANT: in prod with a pg Pool, pass a single dedicated client
// per request so BEGIN/COMMIT below stay on one connection.
// ============================================================

export const MICRO = 1_000_000;                 // 1 USDT = 1_000_000 micro-units
export const CREATOR_FEE_BPS = 500;             // 5% taken from the creator on funding
export const PLAYER_FEE_BPS  = 1000;            // 10% taken from each payout
// Withdrawals take a percentage — but a percentage alone never covers chain
// gas at the bottom of the range. 2% of $3 is six cents and a jetton transfer
// costs more than that whatever the amount is, so there is a floor as well.
export const WITHDRAW_FEE_BPS = Number(process.env.WITHDRAW_FEE_BPS ?? 200);
export const WITHDRAW_MIN     = Math.round(Number(process.env.WITHDRAW_MIN ?? 5) * MICRO);
// withdrawal_pending is guarded too: money reserved for a payout is still real
// money, and a bug that drove it negative would mint some.
const GUARDED = new Set(['user', 'escrow', 'withdrawal_pending']);

// run fn inside a single DB transaction; rolls back on any throw
export async function withTx(db, fn) {
  await db.query('BEGIN');
  try {
    const out = await fn();
    await db.query('COMMIT');
    return out;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export async function accountId(db, kind, ownerId = '', currency = 'USDT') {
  // create-on-demand, return the id
  const sel = await db.query(
    `SELECT id FROM accounts WHERE kind=$1 AND owner_id=$2 AND currency=$3`,
    [kind, ownerId, currency]);
  if (sel.rows.length) return Number(sel.rows[0].id);
  const ins = await db.query(
    `INSERT INTO accounts(kind, owner_id, currency) VALUES($1,$2,$3)
       ON CONFLICT (kind, owner_id, currency) DO UPDATE SET currency=EXCLUDED.currency
       RETURNING id`,
    [kind, ownerId, currency]);
  return Number(ins.rows[0].id);
}

export async function balanceOf(db, kind, ownerId = '', currency = 'USDT') {
  const r = await db.query(
    `SELECT balance FROM accounts WHERE kind=$1 AND owner_id=$2 AND currency=$3`,
    [kind, ownerId, currency]);
  return r.rows.length ? Number(r.rows[0].balance) : 0;
}

// The heart of the system. `entries` = [{ accountId, amount }], must sum to 0.
// Must be called inside withTx(). Exported for the migration's opening transaction.
export async function postTx(db, { type, ref = null, meta = null, entries }) {
  const sum = entries.reduce((a, e) => a + e.amount, 0);
  if (sum !== 0) throw new Error(`unbalanced transaction (sum=${sum}) — refused`);
  if (entries.some(e => !Number.isInteger(e.amount))) throw new Error('non-integer amount');

  // lock all involved accounts in a deterministic order to avoid deadlocks
  const ids = [...new Set(entries.map(e => e.accountId))].sort((a, b) => a - b);
  const locked = await db.query(
    `SELECT id, kind, balance FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [ids]);
  const cur = new Map(locked.rows.map(r => [Number(r.id), { kind: r.kind, balance: Number(r.balance) }]));

  // compute resulting balances and enforce non-negativity on guarded accounts
  const delta = new Map();
  for (const e of entries) delta.set(e.accountId, (delta.get(e.accountId) || 0) + e.amount);
  for (const [id, d] of delta) {
    const acc = cur.get(id);
    const next = acc.balance + d;
    // This message reaches the player, so state the shortfall as money — the
    // raw micro-unit balance and the internal account id belong in logs.
    if (GUARDED.has(acc.kind) && next < 0) {
      const short = (-next / MICRO).toFixed(2).replace(/\.00$/, '');
      throw new Error(`insufficient funds: ${acc.kind} is $${short} short`);
    }
  }

  const tx = await db.query(
    `INSERT INTO ledger_tx(type, ref, meta) VALUES($1,$2,$3::jsonb) RETURNING id`,
    [type, ref, meta ? JSON.stringify(meta) : null]);
  const txId = Number(tx.rows[0].id);

  for (const e of entries) {
    await db.query(`INSERT INTO ledger_entries(tx_id, account_id, amount) VALUES($1,$2,$3)`,
      [txId, e.accountId, e.amount]);
  }
  for (const [id, d] of delta) {
    await db.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [d, id]);
  }
  return txId;
}

// ---- high-level operations -----------------------------------

// Credit a user after an on-chain deposit has CONFIRMED (verify on-chain first!).
export function deposit(db, userId, amount, txhash) {
  if (amount <= 0) throw new Error('amount must be positive');
  return withTx(db, async () => {
    const ext = await accountId(db, 'external');
    const usr = await accountId(db, 'user', userId);
    return postTx(db, { type: 'deposit', ref: txhash, meta: { userId },
      entries: [{ accountId: ext, amount: -amount }, { accountId: usr, amount: +amount }] });
  });
}

// Creator posts a dare: locks reward*winners into escrow + pays the creator fee.
export function fundDare(db, { code, creatorId, reward, maxWinners, feeBps = CREATOR_FEE_BPS, expiresAt = null }) {
  if (reward <= 0 || maxWinners < 1) throw new Error('bad dare params');
  const total = reward * maxWinners;
  const fee = Math.floor(total * feeBps / 10000);
  return withTx(db, async () => {
    const creator = await accountId(db, 'user', creatorId);
    const escrow  = await accountId(db, 'escrow');
    const fees    = await accountId(db, 'platform_fees');
    // postTx enforces the creator has total+fee; otherwise it throws and rolls back.
    await postTx(db, { type: 'fund_dare', ref: code, meta: { creatorId, reward, maxWinners },
      entries: [
        { accountId: creator, amount: -(total + fee) },
        { accountId: escrow,  amount: +total },
        { accountId: fees,    amount: +fee },
      ] });
    const d = await db.query(
      `INSERT INTO dares(code, creator_id, reward, max_winners, fee_bps, escrow_locked, expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, creatorId, reward, maxWinners, feeBps, total, expiresAt]);
    return { dareId: Number(d.rows[0].id), locked: total, fee };
  });
}

export function submitProof(db, { dareId, hunterId, vhash = null }) {
  return withTx(db, async () => {
    const dr = await db.query(`SELECT status FROM dares WHERE id=$1 FOR UPDATE`, [dareId]);
    if (!dr.rows.length) throw new Error('dare not found');
    if (dr.rows[0].status !== 'open') throw new Error('dare not open');
    const s = await db.query(
      `INSERT INTO submissions(dare_id, hunter_id, vhash) VALUES($1,$2,$3) RETURNING id`,
      [dareId, hunterId, vhash]);
    return { submissionId: Number(s.rows[0].id) };
  });
}

// How long after a rejection a hunter may appeal it (see appealSubmission).
export const APPEAL_WINDOW_MS = 48 * 3600 * 1000;

// Pay one winner slot for `sub` from `dare`'s escrow (minus the player fee).
// Assumes both rows are already SELECT ... FOR UPDATE locked by the caller.
// Shared by approveSubmission and resolveDispute so an appeal that succeeds
// pays out through the exact same conserved transaction as a normal approval.
async function payoutSlot(db, sub, dare, playerFeeBps) {
  const approved = await db.query(
    `SELECT count(*)::int AS n FROM submissions WHERE dare_id=$1 AND status='approved'`, [sub.dare_id]);
  if (approved.rows[0].n >= dare.max_winners) throw new Error('all winner slots already filled');

  const reward = Number(dare.reward);
  if (Number(dare.escrow_locked) < reward) throw new Error('escrow underfunded — refusing payout');

  const playerFee = Math.floor(reward * playerFeeBps / 10000);
  const payout = reward - playerFee;

  const escrow = await accountId(db, 'escrow');
  const hunter = await accountId(db, 'user', sub.hunter_id);
  const fees   = await accountId(db, 'platform_fees');
  await postTx(db, { type: 'payout', ref: dare.code, meta: { submissionId: sub.id, dareId: sub.dare_id },
    entries: [
      { accountId: escrow, amount: -reward },
      { accountId: hunter, amount: +payout },
      { accountId: fees,   amount: +playerFee },
    ] });

  await db.query(`UPDATE submissions SET status='approved', decided_at=now() WHERE id=$1`, [sub.id]);
  const left = Number(dare.escrow_locked) - reward;
  const nowFilled = approved.rows[0].n + 1 >= dare.max_winners;
  await db.query(`UPDATE dares SET escrow_locked=$1, status=$2 WHERE id=$3`,
    [left, nowFilled ? 'closed' : 'open', sub.dare_id]);
  return { payout, playerFee, slotsLeft: dare.max_winners - (approved.rows[0].n + 1) };
}

// Admin approves a submission -> pays one winner slot from escrow (minus player fee).
export function approveSubmission(db, submissionId, { playerFeeBps = PLAYER_FEE_BPS } = {}) {
  return withTx(db, async () => {
    const s = await db.query(`SELECT * FROM submissions WHERE id=$1 FOR UPDATE`, [submissionId]);
    if (!s.rows.length) throw new Error('submission not found');
    const sub = s.rows[0];
    if (sub.status !== 'pending') throw new Error('submission already decided');

    const d = await db.query(`SELECT * FROM dares WHERE id=$1 FOR UPDATE`, [sub.dare_id]);
    const dare = d.rows[0];
    if (dare.status !== 'open') throw new Error('dare not open');
    return payoutSlot(db, sub, dare, playerFeeBps);
  });
}

export function rejectSubmission(db, submissionId, reason) {
  return withTx(db, async () => {
    const r = await db.query(
      `UPDATE submissions SET status='rejected', reason=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING id`,
      [submissionId, String(reason || '').slice(0, 200)]);
    if (!r.rows.length) throw new Error('submission not pending');
    return { ok: true };
  });
}

// ---- dispute / appeal ----------------------------------------
// A rejected hunter can contest the decision ONCE. This moves the proof to
// 'disputed' — which is a live status (uniq_live_submission covers it and it
// blocks the dare from expiring), so the slot it is fighting for is held while
// a second reviewer takes a look. No money moves here; escrow only shifts when
// the dispute is resolved.
export function appealSubmission(db, submissionId, { windowMs = APPEAL_WINDOW_MS } = {}) {
  return withTx(db, async () => {
    const s = await db.query(`SELECT * FROM submissions WHERE id=$1 FOR UPDATE`, [submissionId]);
    if (!s.rows.length) throw new Error('submission not found');
    const sub = s.rows[0];
    if (sub.status !== 'rejected') throw new Error('only a rejected proof can be appealed');
    if (sub.appealed_at) throw new Error('you have already appealed this proof once');
    if (sub.decided_at && Date.now() - new Date(sub.decided_at).getTime() > windowMs)
      throw new Error('the appeal window has closed');

    // the dare must still have a slot worth contesting
    const d = await db.query(
      `SELECT status, max_winners,
              (SELECT count(*)::int FROM submissions WHERE dare_id=$1 AND status='approved') AS won
         FROM dares WHERE id=$1 FOR UPDATE`, [sub.dare_id]);
    const dare = d.rows[0];
    if (!dare || dare.status !== 'open') throw new Error('this dare is already closed');
    if (dare.won >= dare.max_winners) throw new Error('all winner slots are already filled');

    // and the hunter can't have another live proof on the same dare
    const live = await db.query(
      `SELECT 1 FROM submissions WHERE dare_id=$1 AND hunter_id=$2 AND id<>$3
              AND status IN ('pending','disputed','approved') LIMIT 1`,
      [sub.dare_id, sub.hunter_id, submissionId]);
    if (live.rows.length) throw new Error('you already have another live proof on this dare');

    await db.query(`UPDATE submissions SET status='disputed', appealed_at=now() WHERE id=$1`, [submissionId]);
    return { ok: true };
  });
}

// A second reviewer resolves an open dispute: uphold the rejection (final, no
// further appeal) or overturn it (pays the slot through payoutSlot()).
export function resolveDispute(db, submissionId, { uphold, reason = null, playerFeeBps = PLAYER_FEE_BPS } = {}) {
  return withTx(db, async () => {
    const s = await db.query(`SELECT * FROM submissions WHERE id=$1 FOR UPDATE`, [submissionId]);
    if (!s.rows.length) throw new Error('submission not found');
    const sub = s.rows[0];
    if (sub.status !== 'disputed') throw new Error('this proof is not under dispute');

    if (uphold) {
      await db.query(`UPDATE submissions SET status='rejected', decided_at=now(), reason=$2 WHERE id=$1`,
        [submissionId, String(reason || sub.reason || '').slice(0, 200)]);
      return { upheld: true };
    }
    const d = await db.query(`SELECT * FROM dares WHERE id=$1 FOR UPDATE`, [sub.dare_id]);
    const dare = d.rows[0];
    if (dare.status !== 'open') throw new Error('dare not open');
    const r = await payoutSlot(db, sub, dare, playerFeeBps);
    return { upheld: false, ...r };
  });
}

// Cancel/expire a dare: refund whatever is still locked back to the creator.
export function refundDare(db, dareId, { cancel = true } = {}) {
  return withTx(db, async () => {
    const d = await db.query(`SELECT * FROM dares WHERE id=$1 FOR UPDATE`, [dareId]);
    if (!d.rows.length) throw new Error('dare not found');
    const dare = d.rows[0];
    const locked = Number(dare.escrow_locked);
    if (locked > 0) {
      const escrow  = await accountId(db, 'escrow');
      const creator = await accountId(db, 'user', dare.creator_id);
      await postTx(db, { type: 'refund', ref: dare.code, meta: { dareId },
        entries: [{ accountId: escrow, amount: -locked }, { accountId: creator, amount: +locked }] });
    }
    await db.query(`UPDATE dares SET escrow_locked=0, status=$2 WHERE id=$1`,
      [dareId, cancel ? 'cancelled' : 'closed']);
    return { refunded: locked };
  });
}

// User withdraws to their own wallet (call only AFTER the on-chain send succeeds).
// Kept for the one-shot path and for the migration; new code should go through
// requestWithdrawal/settleWithdrawal below, which survive a crash in between.
export function withdraw(db, userId, amount, txhash) {
  if (amount <= 0) throw new Error('amount must be positive');
  return withTx(db, async () => {
    const usr = await accountId(db, 'user', userId);
    const ext = await accountId(db, 'external');
    return postTx(db, { type: 'withdraw', ref: txhash, meta: { userId },
      entries: [{ accountId: usr, amount: -amount }, { accountId: ext, amount: +amount }] });
  });
}

// ---- withdrawals, in two phases ------------------------------
//
// Doing this in one step is not safe in either order. Send on-chain first and
// a crash before the ledger write leaves the user paid AND still holding the
// balance — a free withdrawal, repeatable. Debit first and a failed send
// leaves them short money that never arrived.
//
// So the money moves out of reach immediately and waits in its own account:
//
//   request  user -> withdrawal_pending      (balance drops now, nothing sent)
//   settle   withdrawal_pending -> external  (after the send lands)  + fee
//   cancel   withdrawal_pending -> user      (declined, or the send failed)
//
// A crash between phases leaves a row in 'requested' with the funds parked and
// conservation intact — recoverable by hand, and never money out of thin air.

// Phase one: reserve. Nothing touches a chain here.
export function requestWithdrawal(db, { userId, amount, chain, address, feeBps = WITHDRAW_FEE_BPS }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  if (amount < WITHDRAW_MIN)
    throw new Error(`minimum withdrawal is $${(WITHDRAW_MIN / MICRO).toFixed(2).replace(/\.00$/, '')}`);
  const fee = Math.floor(amount * feeBps / 10000);
  const net = amount - fee;
  if (net <= 0) throw new Error('the fee would consume the whole withdrawal');
  return withTx(db, async () => {
    const usr  = await accountId(db, 'user', userId);
    const pend = await accountId(db, 'withdrawal_pending', userId);
    // postTx refuses to overdraw a guarded account, so an over-request throws
    // here with the shortfall in dollars rather than being caught by a check
    // somewhere above that could drift out of step with the balance.
    const txId = await postTx(db, { type: 'withdraw_request', meta: { userId, chain, address },
      entries: [{ accountId: usr, amount: -amount }, { accountId: pend, amount: +amount }] });
    const r = await db.query(
      `INSERT INTO withdrawals(user_id, chain, address, gross, fee, net)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [String(userId), chain, address, amount, fee, net]);
    return { id: Number(r.rows[0].id), txId, gross: amount, fee, net };
  });
}

// Phase two: the send landed. The reserve leaves the building — net to the
// outside world, fee to the platform. `txhash` is the idempotency key: the
// uniq_withdraw_ref index refuses a second settle on the same hash.
export function settleWithdrawal(db, id, txhash) {
  if (!txhash) throw new Error('settling a withdrawal needs the on-chain hash');
  return withTx(db, async () => {
    const w = (await db.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!w) throw new Error('no such withdrawal');
    if (w.status !== 'requested') throw new Error(`withdrawal is already ${w.status}`);
    const pend = await accountId(db, 'withdrawal_pending', w.user_id);
    const ext  = await accountId(db, 'external');
    const fees = await accountId(db, 'platform_fees');
    const entries = [{ accountId: pend, amount: -Number(w.gross) },
                     { accountId: ext,  amount: +Number(w.net) }];
    if (Number(w.fee) > 0) entries.push({ accountId: fees, amount: +Number(w.fee) });
    await postTx(db, { type: 'withdraw', ref: txhash,
      meta: { userId: w.user_id, withdrawalId: Number(id), chain: w.chain }, entries });
    await db.query(`UPDATE withdrawals SET status='sent', txhash=$2, decided_at=now() WHERE id=$1`,
      [id, txhash]);
    return { ok: true, net: Number(w.net), fee: Number(w.fee) };
  });
}

// Declined by a reviewer, or the chain send failed. All of it goes back —
// including the fee, which was never earned because nothing was sent.
export function cancelWithdrawal(db, id, { status = 'rejected', reason = null } = {}) {
  if (status !== 'rejected' && status !== 'failed') throw new Error('cancel status must be rejected or failed');
  return withTx(db, async () => {
    const w = (await db.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!w) throw new Error('no such withdrawal');
    if (w.status !== 'requested') throw new Error(`withdrawal is already ${w.status}`);
    const pend = await accountId(db, 'withdrawal_pending', w.user_id);
    const usr  = await accountId(db, 'user', w.user_id);
    await postTx(db, { type: 'withdraw_cancel',
      meta: { userId: w.user_id, withdrawalId: Number(id), reason },
      entries: [{ accountId: pend, amount: -Number(w.gross) },
                { accountId: usr,  amount: +Number(w.gross) }] });
    await db.query(`UPDATE withdrawals SET status=$2, reason=$3, decided_at=now() WHERE id=$1`,
      [id, status, reason ? String(reason).slice(0, 300) : null]);
    return { ok: true, returned: Number(w.gross) };
  });
}

// ---- integrity checks (for monitoring / tests) ---------------

// Sum of every account balance must be exactly 0 (double-entry conservation).
export async function totalConservation(db) {
  const r = await db.query(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts`);
  return Number(r.rows[0].s);
}
// The cached balances must equal the journal. Returns [] if perfectly consistent.
export async function reconcile(db) {
  const r = await db.query(`
    SELECT a.id, a.kind, a.owner_id, a.balance,
           COALESCE((SELECT SUM(amount) FROM ledger_entries e WHERE e.account_id=a.id),0) AS journal
      FROM accounts a`);
  return r.rows
    .filter(x => Number(x.balance) !== Number(x.journal))
    .map(x => ({ id: Number(x.id), kind: x.kind, owner: x.owner_id, balance: Number(x.balance), journal: Number(x.journal) }));
}
// What we owe users right now = the minimum real reserve we must hold on-chain.
// What the house owes. Money reserved for a withdrawal is still owed until it
// has actually left — leaving it out here would make the float look healthier
// than it is exactly while a payout is queued.
export async function liabilities(db) {
  const r = await db.query(
    `SELECT COALESCE(SUM(balance),0) AS s FROM accounts
      WHERE kind IN ('user','escrow','withdrawal_pending')`);
  return Number(r.rows[0].s);
}
