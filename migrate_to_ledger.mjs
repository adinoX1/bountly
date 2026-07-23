// ============================================================
// BOUNTLY — one-time migration: old JSON app_state -> ledger tables
//
// The current server stores everything in one JSON blob:
//   { users:{id:{credits,...}}, challenges:[...], submissions:[...], txns:[...] }
// This script takes a snapshot of that blob and recreates it as proper
// double-entry ledger state, WITHOUT replaying history:
//   * every user's current `credits` becomes their opening balance,
//   * each still-open dare's UNPAID slots become locked escrow,
//   * historical platform fees are recorded as revenue,
//   * dares + submissions rows are recreated.
//
// It is idempotent-guarded by the `migrations` marker table: it refuses
// to run twice. Run inside a transaction — all or nothing.
//
// Usage:
//   import { migrateAppState } from './migrate_to_ledger.mjs';
//   await migrateAppState(db, appStateObject);
// (db = anything with async .query(); in prod a single pg client.)
// ============================================================
import { withTx, postTx, accountId, MICRO } from './ledger.js';

const toMicro = credits => Math.round(Number(credits || 0) * MICRO);

export async function migrateAppState(db, st) {
  return withTx(db, async () => {
    // guard: never run twice
    await db.query(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now())`);
    const done = await db.query(`SELECT 1 FROM migrations WHERE name='app_state_to_ledger'`);
    if (done.rows.length) throw new Error('migration already applied — refusing to run again');

    const users = Object.values(st.users || {});
    const challenges = st.challenges || [];
    const submissions = st.submissions || [];
    const txns = st.txns || [];

    // username -> telegram id (dares/submissions in the old model reference usernames)
    const idByName = {};
    for (const u of users) idByName[u.username] = String(u.id);
    const creatorIdOf = name => idByName[name] || String(name); // fall back to the name itself

    // how many winners are already approved per old challenge id
    const approvedByCh = {};
    for (const s of submissions) if (s.status === 'approved') approvedByCh[s.chId] = (approvedByCh[s.chId] || 0) + 1;
    const remainingSlots = c => Math.max(0, c.maxWinners - (approvedByCh[c.id] || 0));

    // ---- 1) opening-balance transaction (one balanced journal entry) ----
    const ext    = await accountId(db, 'external');
    const escrow = await accountId(db, 'escrow');
    const fees   = await accountId(db, 'platform_fees');

    const entries = [];
    let extTotal = 0;

    for (const u of users) {
      const amt = toMicro(u.credits);
      if (amt !== 0) {
        const acc = await accountId(db, 'user', String(u.id));
        entries.push({ accountId: acc, amount: +amt });
        extTotal += amt;
      }
    }
    let escrowTotal = 0;
    for (const c of challenges) escrowTotal += remainingSlots(c) * toMicro(c.reward);
    if (escrowTotal > 0) { entries.push({ accountId: escrow, amount: +escrowTotal }); extTotal += escrowTotal; }

    let feesTotal = 0;
    for (const t of txns) if (t.type === 'fee' || t.type === 'commission') feesTotal += toMicro(t.amount);
    if (feesTotal > 0) { entries.push({ accountId: fees, amount: +feesTotal }); extTotal += feesTotal; }

    // external is the contra side so the whole thing nets to zero
    entries.push({ accountId: ext, amount: -extTotal });
    await postTx(db, { type: 'opening', ref: 'migration',
      meta: { note: 'opening balances migrated from app_state', users: users.length }, entries });

    // ---- 2) recreate dares, remember old id -> new dare id ----
    const dareIdByOld = {};
    for (const c of challenges) {
      const left = remainingSlots(c);
      const r = await db.query(
        `INSERT INTO dares(code, creator_id, reward, max_winners, fee_bps, status, escrow_locked, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7, to_timestamp($8::double precision/1000))
           ON CONFLICT (code) DO NOTHING
           RETURNING id`,
        [c.code, creatorIdOf(c.creator), toMicro(c.reward), c.maxWinners, 500,
         left > 0 ? 'open' : 'closed', left * toMicro(c.reward), Number(c.createdAt) || Date.now()]);
      if (r.rows.length) dareIdByOld[c.id] = Number(r.rows[0].id);
      else {
        const ex = await db.query(`SELECT id FROM dares WHERE code=$1`, [c.code]);
        dareIdByOld[c.id] = Number(ex.rows[0].id);
      }
    }

    // ---- 3) recreate submissions ----
    let subCount = 0;
    for (const s of submissions) {
      const dareId = dareIdByOld[s.chId];
      if (!dareId) continue; // orphan submission, skip
      const hunterId = String(s.userId || idByName[s.player] || s.player);
      await db.query(
        // the WHERE clause must mirror uniq_live_submission's predicate, otherwise
        // Postgres can't infer which (partial) index this ON CONFLICT targets
        `INSERT INTO submissions(dare_id, hunter_id, vhash, status, reason, created_at)
           VALUES($1,$2,$3,$4,$5, to_timestamp($6::double precision/1000))
           ON CONFLICT (dare_id, hunter_id) WHERE status <> 'rejected' DO NOTHING`,
        [dareId, hunterId, s.vhash || null, s.status || 'pending',
         s.reason || null, Number(s.at) || Date.now()]);
      subCount++;
    }

    await db.query(`INSERT INTO migrations(name) VALUES('app_state_to_ledger')`);
    return { users: users.length, dares: challenges.length, submissions: subCount,
      openingMicro: extTotal, escrowMicro: escrowTotal, feesMicro: feesTotal };
  });
}
