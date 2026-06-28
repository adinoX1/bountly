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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_SCHEMA = fs.readFileSync(path.join(__dirname, 'ledger_schema.sql'), 'utf8');

// extra columns/sequence layered on top of the money schema
const EXTRA_SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS dare_code_seq;
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS descr TEXT NOT NULL DEFAULT '';
ALTER TABLE dares       ADD COLUMN IF NOT EXISTS rules TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file  TEXT;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS video TEXT;
`;

export const MICRO = L.MICRO;
const toUsdt   = micro => Number(micro) / MICRO;
const toMicro  = usdt  => Math.round(Number(usdt) * MICRO);

// run multi-statement SQL on either a PGlite (.exec) or pg client (.query)
async function runSql(db, sql) { if (db.exec) return db.exec(sql); return db.query(sql); }

export async function initLedger(db) {
  await runSql(db, BASE_SCHEMA);
  await runSql(db, EXTRA_SCHEMA);
}

// acquire a dedicated client for one transaction (prod pg Pool)
export async function withClient(pool, fn) {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

// ---- writes -------------------------------------------------

// Create a dare WITH content, locking escrow + fee, atomically.
export async function createDare(db, { creatorId, title, desc, rules, rewardUsdt, maxWinners, feeBps = L.CREATOR_FEE_BPS }) {
  const reward = toMicro(rewardUsdt);
  if (reward <= 0 || maxWinners < 1) throw new Error('bad dare params');
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
      `INSERT INTO dares(code, creator_id, reward, max_winners, fee_bps, escrow_locked, title, descr, rules)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [code, String(creatorId), reward, maxWinners, feeBps, total,
       String(title).slice(0, 120), String(desc).slice(0, 500), String(rules || '').slice(0, 400)]);
    return { dareId: Number(d.rows[0].id), code, lockedUsdt: toUsdt(total + fee) };
  });
}

export async function submit(db, { dareId, hunterId, vhash = null, file = null, video = null }) {
  return L.withTx(db, async () => {
    const dr = await db.query(`SELECT status FROM dares WHERE id=$1 FOR UPDATE`, [dareId]);
    if (!dr.rows.length) throw new Error('dare not found');
    if (dr.rows[0].status !== 'open') throw new Error('dare not open');
    const s = await db.query(
      `INSERT INTO submissions(dare_id, hunter_id, vhash, file, video) VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [dareId, String(hunterId), vhash, file, video]);
    return { submissionId: Number(s.rows[0].id) };
  });
}

export const approve  = (db, submissionId) => L.approveSubmission(db, submissionId);
export const reject   = (db, submissionId, reason) => L.rejectSubmission(db, submissionId, reason);
export const refund   = (db, dareId) => L.refundDare(db, dareId);
export const deposit  = (db, userId, usdt, txhash) => L.deposit(db, String(userId), toMicro(usdt), txhash);
export const withdraw = (db, userId, usdt, txhash) => L.withdraw(db, String(userId), toMicro(usdt), txhash);

// ---- read models (return whole USDT to match the current UI) ----

export async function balance(db, userId) {
  return toUsdt(await L.balanceOf(db, 'user', String(userId)));
}

export async function listDares(db) {
  const r = await db.query(`
    SELECT d.*,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status='approved')::int AS won,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status<>'rejected')::int AS subs,
      (SELECT count(*) FROM submissions s WHERE s.dare_id=d.id AND s.status='pending')::int  AS pending
    FROM dares d ORDER BY d.id DESC`);
  return r.rows.map(d => ({
    id: Number(d.id), code: d.code, title: d.title, desc: d.descr, rules: d.rules,
    reward: toUsdt(d.reward), maxWinners: d.max_winners, creator: d.creator_id,
    slots: [d.won, d.max_winners], full: d.won >= d.max_winners,
    subs: d.subs, pending: d.pending,
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

export async function leaderboard(db) {
  const r = await db.query(`
    SELECT a.owner_id AS username,
      (SELECT count(*) FROM submissions s WHERE s.hunter_id=a.owner_id AND s.status='approved')::int AS wins,
      COALESCE((SELECT SUM(e.amount) FROM ledger_entries e
                  JOIN ledger_tx t ON t.id=e.tx_id
                 WHERE t.type='payout' AND e.account_id=a.id AND e.amount>0),0) AS earned
      FROM accounts a WHERE a.kind='user'
     ORDER BY wins DESC, earned DESC LIMIT 20`);
  return r.rows.map(x => ({ username: x.username, wins: x.wins, earnedUsdt: toUsdt(x.earned) }));
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

// monitoring passthroughs
export const conservation = db => L.totalConservation(db);
export const reconcile    = db => L.reconcile(db);
export const liabilities  = async db => toUsdt(await L.liabilities(db));
