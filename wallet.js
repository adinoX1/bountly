// ============================================================
// BOUNTLY — wallet.js : the bridge the server calls.
//
// Wraps the double-entry ledger (ledger.js) with the operations and
// read-models server.js needs, and owns the dare/submission CONTENT
// (title, desc, rules, file, video) on top of the money tables.
//
// All amounts are micro-units internally (1 USDT = 1e6). The read
// models return whole USDT so the existing frontend keeps working.
//
// In prod pass a pooled `pg` client per request (see withClient).
// In tests pass a PGlite instance directly.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './ledger.js';
import * as D from './deposits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extra columns/sequence layered on top of the money schema
const EXTRA_SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS dare_code_seq;
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS descr TEXT NOT NULL DEFAULT '';
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS rules TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file  TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS video TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS decided_at  TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS appealed_at TIMESTAMPTZ;
-- widen the status CHECK to allow 'disputed' (see appealSubmission). Drop then
-- re-add so it is safe to run on a database created by the older schema.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE submissions ADD  CONSTRAINT submissions_status_check CHECK (status IN ('pending','approved','rejected','disputed'));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deposit_ref  ON ledger_tx(ref) WHERE type='deposit'  AND ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_withdraw_ref ON ledger_tx(ref) WHERE type='withdraw' AND ref IS NOT NULL;
-- A rejected proof must not block a retry. The original table-level
-- UNIQUE(dare_id, hunter_id) blocked it forever, contradicting the
-- "you can try again on this dare" message we send on rejection.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_dare_id_hunter_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_submission
  ON submissions(dare_id, hunter_id) WHERE status <> 'rejected';
-- ---- withdrawals -------------------------------------------------------
-- Money on its way out sits in its own account kind rather than leaving the
-- user's balance for nowhere. Widen the CHECK the same drop/re-add way as
-- above so an older database accepts it.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE accounts ADD  CONSTRAINT accounts_kind_check
  CHECK (kind IN ('user','escrow','platform_fees','external','withdrawal_pending'));
CREATE TABLE IF NOT EXISTS withdrawals (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  chain        TEXT NOT NULL CHECK (chain IN ('ton','sol')),
  address      TEXT NOT NULL,
  gross        BIGINT NOT NULL CHECK (gross > 0),   -- taken from the user, micro-units
  fee          BIGINT NOT NULL CHECK (fee >= 0),    -- kept by the platform
  net          BIGINT NOT NULL CHECK (net > 0),     -- actually sent on-chain
  status       TEXT NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','sent','failed','rejected')),
  txhash       TEXT,
  reason       TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user   ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
-- One in flight per person. Two taps must never become two payouts, and the
-- database is a better place to enforce that than a button's disabled state.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_withdrawal
  ON withdrawals(user_id) WHERE status = 'requested';
`;

export const MICRO = L.MICRO;
const toUsdt   = micro => Number(micro) / MICRO;
const toMicro  = usdt  => Math.round(Number(usdt) * MICRO);

// run multi-statement SQL on either a PGlite (.exec) or pg client (.query)
async function runSql(db, sql) { if (db.exec) return db.exec(sql); return db.query(sql); }

export async function initLedger(db) {
  const BASE_SCHEMA = fs.readFileSync(path.join(__dirname, 'ledger_schema.sql'), 'utf8');
  await runSql(db, BASE_SCHEMA);
  await runSql(db, EXTRA_SCHEMA);
  await D.ensureSchema(db);   // in-flight on-chain deposits
}

// acquire a dedicated client for one transaction (prod pg Pool).
// PGlite (tests) has no .connect — it's already a single connection.
export async function withClient(pool, fn) {
  if (!pool || !pool.connect) return fn(pool);
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

// ---- writes -------------------------------------------------

// Create a dare WITH content, locking escrow + fee, atomically.
// expiresInDays caps how long the creator's escrow can stay locked; null means
// "never expires", which is what every dare used to be.
export async function createDare(db, { creatorId, title, desc, rules, rewardUsdt, maxWinners, feeBps = L.CREATOR_FEE_BPS, expiresInDays = null }) {
  const reward = toMicro(rewardUsdt);
  if (reward <= 0 || maxWinners < 1) throw new Error('bad dare params');
  const ttl = expiresInDays == null ? null : Number(expiresInDays);
  if (ttl != null && !(ttl > 0 && ttl <= 365)) throw new Error('expiresInDays must be between 1 and 365');
  const total = reward * maxWinners;
  const fee = Math.floor(total * feeBps / 10000);
  return L.withTx(db, async () => {
    const creator = await L.accountId(db, 'user', String(creatorId));
    const escrow  = await L.accountId(db, 'escrow');
    const fees    = await L.accountId(db, 'platform_fees');
    const n = (await db.query(`SELECT nextval('dare_code_seq') AS n`)).rows[0].n;
    const code = 'BNT-' + String(Number(n)).padStart(3, '0');
    // postTx refuses if the creator can't cover total+fee, and rolls back.
    await L.postTx(db, { type: 'fund_dare', ref: code, meta: { creatorId },
      entries: [
        { accountId: creator, amount: -(total + fee) },
        { accountId: escrow,  amount: +total },
        { accountId: fees,    amount: +fee },
      ] });
    const d = await db.query(
      `INSERT INTO dares(code, creator_id, reward, max_winners, fee_bps, escrow_locked, title, descr, rules, expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
                CASE WHEN $10::float8 IS NULL THEN NULL ELSE now() + ($10::float8 * interval '1 day') END)
         RETURNING id, expires_at`,
      [code, String(creatorId), reward, maxWinners, feeBps, total,
       String(title).slice(0, 120), String(desc).slice(0, 500), String(rules || '').slice(0, 400), ttl]);
    return { dareId: Number(d.rows[0].id), code, lockedUsdt: toUsdt(total + fee),
      expiresAt: d.rows[0].expires_at ? new Date(d.rows[0].expires_at).getTime() : null };
  });
}

// All the guards run inside the same transaction that locks the dare row,
// so two proofs racing for the last slot can't both get in.
export async function submit(db, { dareId, hunterId, vhash = null, file = null, video = null }) {
  const hunter = String(hunterId);
  return L.withTx(db, async () => {
    const dr = await db.query(
      `SELECT status, creator_id, max_winners, expires_at FROM dares WHERE id=$1 FOR UPDATE`, [dareId]);
    if (!dr.rows.length) throw new Error('dare not found');
    const dare = dr.rows[0];
    if (dare.status !== 'open') throw new Error('dare not open');
    if (dare.creator_id === hunter) throw new Error("you can't complete your own dare");
    // the sweeper runs on an interval, so a dare can be past its deadline and
    // still be status='open' — don't let anyone slip a proof in through the gap
    if (dare.expires_at && new Date(dare.expires_at).getTime() <= Date.now())
      throw new Error('this dare has expired');

    const won = await db.query(
      `SELECT count(*)::int AS n FROM submissions WHERE dare_id=$1 AND status='approved'`, [dareId]);
    if (won.rows[0].n >= dare.max_winners) throw new Error('slots full');

    const mine = await db.query(
      `SELECT 1 FROM submissions WHERE dare_id=$1 AND hunter_id=$2 AND status<>'rejected' LIMIT 1`,
      [dareId, hunter]);
    if (mine.rows.length) throw new Error('you already submitted to this dare');

    const s = await db.query(
      `INSERT INTO submissions(dare_id, hunter_id, vhash, file, video) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [dareId, hunter, vhash, file, video]);
    return { submissionId: Number(s.rows[0].id) };
  });
}

// Text-only edit. Money fields (reward, max_winners) are deliberately NOT
// editable — they back an escrow balance that is already locked.
export async function editDare(db, dareId, { title, desc, rules }) {
  const sets = [], vals = [];
  if (title != null) { sets.push(`title=$${sets.length + 2}`); vals.push(String(title).slice(0, 120)); }
  if (desc  != null) { sets.push(`descr=$${sets.length + 2}`); vals.push(String(desc).slice(0, 500)); }
  if (rules != null) { sets.push(`rules=$${sets.length + 2}`); vals.push(String(rules).slice(0, 400)); }
  if (!sets.length) return { ok: true };
  const r = await db.query(`UPDATE dares SET ${sets.join(', ')} WHERE id=$1 RETURNING id`, [dareId, ...vals]);
  if (!r.rows.length) throw new Error('dare not found');
  return { ok: true };
}

export const approve  = (db, submissionId) => L.approveSubmission(db, submissionId);
export const reject   = (db, submissionId, reason) => L.rejectSubmission(db, submissionId, reason);
export const appeal   = (db, submissionId) => L.appealSubmission(db, submissionId);
export const resolveDispute = (db, submissionId, opts) => L.resolveDispute(db, submissionId, opts);
export const refund   = (db, dareId) => L.refundDare(db, dareId);
export const APPEAL_WINDOW_MS = L.APPEAL_WINDOW_MS;
export const deposit  = (db, userId, usdt, txhash) => L.deposit(db, String(userId), toMicro(usdt), txhash);
export const withdraw = (db, userId, usdt, txhash) => L.withdraw(db, String(userId), toMicro(usdt), txhash);

// ---- withdrawals -------------------------------------------------------
export const WITHDRAW_FEE_BPS = L.WITHDRAW_FEE_BPS;
export const WITHDRAW_MIN     = toUsdt(L.WITHDRAW_MIN);

// Ask to take money out. Reserves it; sends nothing. Every request waits for
// a human — see the approval note in server_ledger.js.
export async function requestWithdrawal(db, { userId, usdt, chain, address }) {
  if (chain !== 'ton' && chain !== 'sol') throw new Error('chain must be ton or sol');
  const addr = String(address || '').trim();
  if (!addr) throw new Error('paste the address to send to');
  // Validated here, before any balance moves, using the chain's own rules.
  const mod = chain === 'ton' ? await import('./ton.js') : await import('./solana.js');
  if (!mod.isValidAddress(addr)) throw new Error(`that is not a valid ${chain === 'ton' ? 'TON' : 'Solana'} address`);
  try {
    const r = await L.requestWithdrawal(db, { userId: String(userId), amount: toMicro(usdt), chain, address: addr });
    return { ...r, gross: toUsdt(r.gross), fee: toUsdt(r.fee), net: toUsdt(r.net) };
  } catch (e) {
    // The partial unique index is the real guard against a double tap; turn
    // its Postgres error into something a person can act on.
    if (/uniq_open_withdrawal/.test(e.message))
      throw new Error('you already have a withdrawal waiting for review');
    throw e;
  }
}

export const settleWithdrawal = (db, id, ref)      => L.settleWithdrawal(db, id, ref);
export const cancelWithdrawal = (db, id, opts)     => L.cancelWithdrawal(db, id, opts);

const wRow = w => ({ id: Number(w.id), user: w.user_id, chain: w.chain, address: w.address,
  gross: toUsdt(w.gross), fee: toUsdt(w.fee), net: toUsdt(w.net), status: w.status,
  txhash: w.txhash, reason: w.reason,
  at: w.requested_at ? new Date(w.requested_at).getTime() : 0,
  decidedAt: w.decided_at ? new Date(w.decided_at).getTime() : null });

export async function userWithdrawals(db, userId, limit = 20) {
  const r = await db.query(
    `SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT $2`, [String(userId), limit]);
  return r.rows.map(wRow);
}

// The review queue: oldest first, because the person who waited longest for
// their money should not be behind the one who asked a minute ago.
export async function pendingWithdrawals(db, limit = 100) {
  const r = await db.query(
    `SELECT * FROM withdrawals WHERE status='requested' ORDER BY id ASC LIMIT $1`, [limit]);
  return r.rows.map(wRow);
}

export async function getWithdrawal(db, id) {
  const r = await db.query(`SELECT * FROM withdrawals WHERE id=$1`, [id]);
  return r.rows.length ? wRow(r.rows[0]) : null;
}

// ---- read models (return whole USDT to match the current UI) ----

export async function balance(db, userId) {
  return toUsdt(await L.balanceOf(db, 'user', String(userId)));
}

export async function listDares(db) {
  const r = await db.query(`
    SELECT d.*,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status='approved')::int AS won,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status<>'rejected')::int AS subs,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status='pending')::int  AS pending,
      -- the first approved clip, so the feed can play the proof behind the
      -- dare. Approved only: nothing under review is ever handed out.
      (SELECT s.video FROM submissions s
         WHERE s.dare_id=d.id AND s.status='approved' AND s.video IS NOT NULL
         ORDER BY s.created_at ASC LIMIT 1) AS proof
    FROM dares d ORDER BY d.id DESC`);
  return r.rows.map(d => ({
    id: Number(d.id), code: d.code, title: d.title, desc: d.descr, rules: d.rules,
    reward: toUsdt(d.reward), maxWinners: d.max_winners, creator: d.creator_id,
    slots: [d.won, d.max_winners], full: d.won >= d.max_winners,
    subs: d.subs, pending: d.pending, status: d.status,
    proof: d.proof ? '/uploads/' + d.proof : null,
    expiresAt: d.expires_at ? new Date(d.expires_at).getTime() : null,
  }));
}

export async function adminQueue(db) {
  const r = await db.query(`
    SELECT s.id, s.hunter_id, s.file, s.video, s.created_at, d.code, d.title
      FROM submissions s JOIN dares d ON d.id=s.dare_id
     WHERE s.status='pending' ORDER BY s.created_at ASC`);
  return r.rows.map(s => ({ id: Number(s.id), player: s.hunter_id, file: s.file, video: s.video,
    code: s.code, title: s.title, at: s.created_at }));
}

// Appeals waiting for a second reviewer. Includes the original reject reason so
// the reviewer sees what was contested. Oldest appeal first — first in, first out.
export async function disputeQueue(db) {
  const r = await db.query(`
    SELECT s.id, s.hunter_id, s.file, s.video, s.reason, s.created_at, s.appealed_at, d.code, d.title
      FROM submissions s JOIN dares d ON d.id=s.dare_id
     WHERE s.status='disputed' ORDER BY s.appealed_at ASC`);
  return r.rows.map(s => ({ id: Number(s.id), player: s.hunter_id, file: s.file, video: s.video,
    reason: s.reason || '', code: s.code, title: s.title, at: s.created_at,
    appealedAt: s.appealed_at ? new Date(s.appealed_at).getTime() : null }));
}

// A leaderboard is the people who have won something. Two things used to leak
// onto it that do not belong: accounts with no wins at all — which, below 20
// winners, filled the board with `0 wins · $0` rows and meant the "nobody has
// won yet" empty state could never show — and admins, whom the JSON-mode board
// has always excluded. The two modes disagreeing is the actual bug; this is the
// side that was wrong.
//
// `exclude` is a list of usernames because that is how the ledger keys accounts.
// The caller has to do the Telegram-id -> username lookup, since ADMIN_IDS is
// ids and owner_id is names. That mismatch is the same one behind the standing
// plan to re-key accounts by id; until then the bridge lives at the call site.
export async function leaderboard(db, { exclude = [] } = {}) {
  const r = await db.query(`
    SELECT * FROM (
      SELECT a.owner_id AS username,
        (SELECT count(*) FROM submissions s WHERE s.hunter_id=a.owner_id AND s.status='approved')::int AS wins,
        COALESCE((SELECT SUM(e.amount) FROM ledger_entries e
                    JOIN ledger_tx t ON t.id=e.tx_id
                   WHERE t.type='payout' AND e.account_id=a.id AND e.amount>0),0) AS earned
        FROM accounts a
       WHERE a.kind='user' AND NOT (a.owner_id = ANY($1::text[]))
    ) q
     WHERE q.wins > 0
     ORDER BY q.wins DESC, q.earned DESC LIMIT 20`, [exclude]);
  return r.rows.map(x => ({ username: x.username, wins: x.wins, earnedUsdt: toUsdt(x.earned) }));
}

// One user's own deposits, newest first — powers the wallet history strip.
export async function userDeposits(db, userId, limit = 20) {
  const r = await db.query(`
    SELECT t.id, t.ref, EXTRACT(EPOCH FROM t.created_at)*1000 AS at, e.amount
      FROM ledger_tx t
      JOIN ledger_entries e ON e.tx_id=t.id
      JOIN accounts a ON a.id=e.account_id
     WHERE t.type='deposit' AND a.kind='user' AND a.owner_id=$1 AND e.amount>0
     ORDER BY t.id DESC LIMIT $2`, [String(userId), limit]);
  return r.rows.map(x => ({ id: Number(x.id), at: Number(x.at), amount: toUsdt(x.amount),
    ref: x.ref || '', source: String(x.ref || '').startsWith('admin-set') ? 'admin' : 'on-chain' }));
}

export async function recentTxns(db, limit = 200) {
  const r = await db.query(`
    SELECT t.id, t.type, t.ref, t.created_at,
           json_agg(json_build_object('account', a.kind || CASE WHEN a.owner_id<>'' THEN ':'||a.owner_id ELSE '' END,
                                       'usdt', e.amount) ORDER BY e.amount) AS entries
      FROM ledger_tx t JOIN ledger_entries e ON e.tx_id=t.id JOIN accounts a ON a.id=e.account_id
     GROUP BY t.id ORDER BY t.id DESC LIMIT $1`, [limit]);
  return r.rows.map(t => ({ id: Number(t.id), type: t.type, ref: t.ref, at: t.created_at,
    entries: t.entries.map(e => ({ account: e.account, usdt: toUsdt(e.usdt) })) }));
}

// ---- expiry ---------------------------------------------------
// Without this a dare nobody completes locks the creator's escrow forever —
// the only way out was an admin deleting the dare by hand.
//
// A dare with proofs still awaiting review is deliberately NOT expired: the
// hunter did their part and is waiting on us, so refunding the creator out
// from under them would be the wrong call. Those are returned as `blocked`
// so they show up somewhere instead of silently sitting there.
export async function expireDares(pool, log = console) {
  const rows = (await pool.query(`
    SELECT d.id, d.code, d.creator_id, d.escrow_locked,
           EXISTS (SELECT 1 FROM submissions s
                    WHERE s.dare_id=d.id AND s.status IN ('pending','disputed')) AS has_open_review
      FROM dares d
     WHERE d.status='open' AND d.expires_at IS NOT NULL AND d.expires_at <= now()`)).rows;

  const expired = [], blocked = [];
  for (const d of rows) {
    // a proof awaiting review OR an open dispute means someone is waiting on us
    if (d.has_open_review) { blocked.push({ code: d.code, creator: d.creator_id }); continue; }
    try {
      // one transaction per dare: a single failure must not block the rest
      const r = await withClient(pool, c => L.refundDare(c, Number(d.id)));
      expired.push({ dareId: Number(d.id), code: d.code, creator: d.creator_id, refundedUsdt: toUsdt(r.refunded) });
    } catch (e) { log.error?.('expireDares', d.code, e.message); }
  }
  return { expired, blocked };
}

// Run the sweeper on an interval. `onExpired(entry)` lets the caller notify the
// creator — the username -> telegram id mapping lives outside this module.
export function startExpiryWatcher(pool, { everyMs = 5 * 60e3, onExpired = null, log = console } = {}) {
  const tick = () => expireDares(pool, log)
    .then(r => { for (const e of r.expired) {
      log.log?.(`dare ${e.code} expired — refunded ${e.refundedUsdt} to @${e.creator}`);
      try { onExpired?.(e); } catch (_) {}
    } })
    .catch(e => log.error?.('expiry watcher:', e.message));
  tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}

// monitoring passthroughs
export const conservation = db => L.totalConservation(db);
export const reconcile    = db => L.reconcile(db);
export const liabilities  = async db => toUsdt(await L.liabilities(db));
