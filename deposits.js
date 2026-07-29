// ============================================================
// BOUNTLY — deposits.js : "has it actually landed on-chain yet?"
//
// Both chains now report a transfer the moment they SEE it, not the
// moment they trust it. Every sighting lands in deposit_watch as
// `seen`; a confirmation pass re-reads the transaction from the chain
// and only credits the ledger once it is deep enough to be final.
// Nothing here trusts a webhook payload, an indexer row or the client:
// a credit always follows a fresh read of the chain.
//
// The same table is what the player watches. While their transfer is
// confirming, GET /api/wallet/pending turns the deposit sheet from a
// blind "waiting…" into "spotted 25 USDT · 2 of 3 confirmations".
//
// Chain-specific reads live in ton.js / solana.js and are injected here
// as `readers`, so the whole loop is testable without a network.
// ============================================================

export const MICRO = 1e6;

// A sighting that never confirms must not hang in the UI forever. TON
// settles in seconds and Solana finalizes in ~30s, so anything still
// unconfirmed after this was dropped, replaced, or never existed.
export const STALE_MS = 30 * 60e3;

// Solana reports progress as "blocks since confirmation", which stops
// being reported once the slot is rooted. This is the denominator we
// show a player — finality, not this number, is what actually gates a
// credit.
export const SOL_NEED = 32;

// ============================================================
// PURE logic — no database, no network. Unit-tested directly.
// ============================================================

// TON: a transfer is as final as the masterchain block holding it is
// deep. Being in the head block already counts as one confirmation.
export function tonConfirms(txSeqno, headSeqno) {
  txSeqno = Number(txSeqno); headSeqno = Number(headSeqno);
  if (!(txSeqno > 0) || !(headSeqno > 0) || headSeqno < txSeqno) return 0;
  return headSeqno - txSeqno + 1;
}

// Solana: the cluster answers directly. `finalized` is the only status
// worth money — `confirmed` is a supermajority vote that a fork can
// still drop.
export function solConfirms(st) {
  if (!st) return { seen: false, failed: false, confirms: 0 };
  if (st.err) return { seen: true, failed: true, confirms: 0, detail: 'transaction failed on-chain' };
  const level = st.confirmationStatus || '';
  if (level === 'finalized') return { seen: true, failed: false, confirms: SOL_NEED };
  const n = typeof st.confirmations === 'number' ? st.confirmations : 0;
  return { seen: true, failed: false, confirms: Math.max(0, Math.min(n, SOL_NEED - 1)) };
}

// What one fresh chain read means for a watched transfer.
export function verdict({ seen, failed, confirms, need }) {
  if (failed) return 'failed';
  if (!seen) return 'unseen';
  return Number(confirms) >= Number(need) ? 'confirmable' : 'confirming';
}

export function isStale(firstSeenMs, now = Date.now()) {
  return now - Number(firstSeenMs) > STALE_MS;
}

export const assetOf = chain => (chain === 'sol' ? 'USDC' : 'USDT');

// What the deposit sheet prints while a transfer is in flight.
export function progressText(row) {
  const amt = `${row.amountUsdt} ${assetOf(row.chain)}`;
  if (row.status === 'credited') return `Credited ${amt}`;
  if (row.status === 'failed')   return row.detail || 'Transfer did not confirm';
  if (row.confirms <= 0)         return `Spotted ${amt} — waiting for the first confirmation`;
  return `Spotted ${amt} — ${row.confirms} of ${row.need} confirmations`;
}

// ============================================================
// Storage
// ============================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposit_watch (
  chain      TEXT NOT NULL,
  txref      TEXT NOT NULL,
  username   TEXT NOT NULL,
  amount     BIGINT NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'seen',
  confirms   INT  NOT NULL DEFAULT 0,
  need       INT  NOT NULL DEFAULT 1,
  detail     TEXT NOT NULL DEFAULT '',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, txref)
);
CREATE INDEX IF NOT EXISTS idx_watch_open ON deposit_watch(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_watch_user ON deposit_watch(username, status);
`;

async function runSql(db, sql) { if (db.exec) return db.exec(sql); return db.query(sql); }
export async function ensureSchema(db) { await runSql(db, SCHEMA); }

const rowOut = r => ({
  chain: r.chain,
  txref: r.txref,
  username: r.username,
  amount: Number(r.amount),
  amountUsdt: Number(r.amount) / MICRO,
  status: r.status,
  confirms: Number(r.confirms),
  need: Number(r.need),
  detail: r.detail || '',
  firstSeen: Number(r.first_seen_ms),
  updatedAt: Number(r.updated_at_ms),
});

const SELECT_ROW = `SELECT chain, txref, username, amount, status, confirms, need, detail,
  EXTRACT(EPOCH FROM first_seen)*1000 AS first_seen_ms,
  EXTRACT(EPOCH FROM updated_at)*1000 AS updated_at_ms
  FROM deposit_watch`;

// Record a transfer we have just seen on-chain. Idempotent: a second
// sighting only refreshes the confirmation count, and a row that has
// already been credited or failed is never dragged back to `seen`.
// A transfer the ledger already knows about is not watched at all —
// that would show a player a pending deposit they were paid for.
export async function noteSeen(db, { chain, txref, username, amountUsdt = 0, confirms = 0, need = 1, detail = '' }) {
  if (!chain || !txref || !username) throw new Error('noteSeen needs chain, txref and username');
  const already = await db.query(
    `SELECT 1 FROM ledger_tx WHERE type='deposit' AND ref=$1 LIMIT 1`, [txref]);
  if (already.rows.length) return { watched: false, reason: 'already credited' };

  const amount = Math.round(Number(amountUsdt) * MICRO);
  await db.query(
    `INSERT INTO deposit_watch (chain, txref, username, amount, confirms, need, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (chain, txref) DO UPDATE
       SET confirms = EXCLUDED.confirms,
           amount   = CASE WHEN EXCLUDED.amount > 0 THEN EXCLUDED.amount ELSE deposit_watch.amount END,
           updated_at = now()
     WHERE deposit_watch.status = 'seen'`,
    [chain, txref, String(username).trim(), amount, Math.max(0, confirms), Math.max(1, need), detail]);
  return { watched: true };
}

export async function bump(db, chain, txref, confirms) {
  await db.query(
    `UPDATE deposit_watch SET confirms=$3, updated_at=now()
      WHERE chain=$1 AND txref=$2 AND status='seen'`, [chain, txref, Math.max(0, confirms)]);
}

export async function markCredited(db, chain, txref, confirms = null) {
  await db.query(
    `UPDATE deposit_watch SET status='credited', updated_at=now(),
            confirms = COALESCE($3, confirms)
      WHERE chain=$1 AND txref=$2`, [chain, txref, confirms]);
}

export async function markFailed(db, chain, txref, detail = '') {
  await db.query(
    `UPDATE deposit_watch SET status='failed', detail=$3, updated_at=now()
      WHERE chain=$1 AND txref=$2 AND status='seen'`, [chain, txref, String(detail).slice(0, 200)]);
}

// Rows the confirmation pass still has to settle, oldest sighting first
// so nothing starves behind a burst of new transfers.
export async function openRows(db, { chain = null, limit = 60 } = {}) {
  const r = chain
    ? await db.query(`${SELECT_ROW} WHERE status='seen' AND chain=$1 ORDER BY first_seen ASC LIMIT $2`, [chain, limit])
    : await db.query(`${SELECT_ROW} WHERE status='seen' ORDER BY first_seen ASC LIMIT $1`, [limit]);
  return r.rows.map(rowOut);
}

// What one player has in flight right now — the deposit sheet's live state.
// Recently settled rows ride along so the sheet can close the loop on a
// transfer it was already showing.
export async function pendingFor(db, username, { sinceMs = 6 * 3600e3, now = Date.now() } = {}) {
  const cutoff = new Date(now - sinceMs).toISOString();
  const r = await db.query(
    `${SELECT_ROW} WHERE username=$1 AND (status='seen' OR updated_at > $2)
      ORDER BY first_seen DESC LIMIT 10`, [String(username).trim(), cutoff]);
  return r.rows.map(rowOut);
}

// A sighting that never confirmed is closed out rather than left spinning.
export async function expireStale(db, { now = Date.now() } = {}) {
  const cutoff = new Date(now - STALE_MS).toISOString();
  const r = await db.query(
    `UPDATE deposit_watch SET status='failed', detail='never confirmed', updated_at=now()
      WHERE status='seen' AND first_seen < $1
      RETURNING chain, txref`, [cutoff]);
  return r.rows.length;
}

// ============================================================
// The confirmation pass
//
// `readers` maps a chain to { status(txref), credit({txref, username,
// amountUsdt}) }. Both are injected, so this loop — the part that
// decides when money moves — is tested against fakes, offline.
// ============================================================
// `onCredited` and `onFailed` are told after the write lands, so a deposit can
// reach the person who sent it. Without them the app is silent about the one
// thing a depositor is actively waiting for: you send USDT to an address and
// nothing ever says it arrived, so you sit refreshing a screen.
//
// Both are fired inside a try/catch and awaited nowhere. A hook is a courtesy;
// the money path is not. A notification that throws — Telegram down, user
// blocked the bot — must never abort the pass or re-credit on the next one.
export async function confirmOpen(db, readers, { log = console, now = Date.now(), limit = 60,
                                                 onCredited = null, onFailed = null } = {}) {
  const rows = await openRows(db, { limit });
  const out = { checked: rows.length, credited: 0, confirming: 0, failed: 0 };
  const fire = (hook, row, extra) => {
    if (!hook) return;
    try { Promise.resolve(hook({ ...row, ...extra })).catch(e => log.error?.('deposit hook', e.message)); }
    catch (e) { log.error?.('deposit hook', e.message); }
  };

  for (const row of rows) {
    const reader = readers && readers[row.chain];
    if (!reader) continue;

    let st;
    try { st = await reader.status(row.txref); }
    catch (e) { log.error?.('confirm read', row.chain, row.txref, e.message); continue; }

    switch (verdict({ ...st, need: row.need })) {
      case 'failed': {
        const reason = st.detail || 'rejected on-chain';
        await markFailed(db, row.chain, row.txref, reason);
        out.failed++;
        fire(onFailed, row, { reason });
        break;
      }

      case 'unseen':
        // Not on-chain yet. Indexers lag, so give it the stale window
        // before calling it dead.
        if (isStale(row.firstSeen, now)) {
          await markFailed(db, row.chain, row.txref, 'never confirmed');
          out.failed++;
          fire(onFailed, row, { reason: 'never confirmed' });
        }
        else out.confirming++;
        break;

      case 'confirming':
        await bump(db, row.chain, row.txref, st.confirms);
        out.confirming++;
        break;

      case 'confirmable':
        try {
          // The credit re-reads the chain itself and is idempotent by
          // txref, so a duplicate pass cannot pay twice.
          const res = await reader.credit({ txref: row.txref, username: row.username, amountUsdt: row.amountUsdt });
          if (res && res.credited === false && res.reason && !/already credited/i.test(res.reason)) {
            // The chain read disagreed with the sighting (wrong mint,
            // below minimum, amount vanished). Close it with the reason.
            await markFailed(db, row.chain, row.txref, res.reason);
            out.failed++;
            fire(onFailed, row, { reason: res.reason });
            break;
          }
          await markCredited(db, row.chain, row.txref, st.confirms);
          if (res && res.credited) {
            out.credited++;
            log.log?.(`deposit confirmed: ${row.amountUsdt} -> @${row.username} (${row.chain} ${String(row.txref).slice(0, 12)})`);
            // Only on a real credit. A second pass over an already-credited
            // row reports credited:false, and telling somebody twice that the
            // same money arrived is worse than not telling them at all.
            fire(onCredited, row, { confirms: st.confirms });
          }
        } catch (e) { log.error?.('credit', row.txref, e.message); }
        break;
    }
  }
  return out;
}

// Run the pass on an interval. Returns the timer so callers can stop it.
export function startConfirmWatcher(db, readers, { everyMs = 15000, log = console,
                                                   onCredited = null, onFailed = null } = {}) {
  const tick = () => confirmOpen(db, readers, { log, onCredited, onFailed })
    .then(() => expireStale(db))
    .catch(e => log.error?.('confirm pass', e.message));
  tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}
