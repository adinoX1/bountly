// ============================================================
// BOUNTLY — LEDGER-mode API handlers.
//
// When server.js runs with LEDGER=1 it delegates the money/dare API
// to ledgerApi() here, which uses the double-entry wallet (wallet.js)
// instead of the old in-memory "credits" blob.
//
// ledgerApi(ctx) returns true if it handled the request, else false
// (so the caller can fall through). ctx is supplied by server.js:
//   { req, res, method, path, url, body, files, user, pool,
//     json, notify, fs, pathMod, crypto, UP_DIR }
//
// ACCOUNT KEY = username (the old app identifies creators/hunters by
// @username, and the frontend shows @username, so the ledger uses it
// as the owner key — keeps the UI working unchanged).
// ============================================================
import * as wallet from './wallet.js';
import * as ton from './ton.js';
import { cfg as tonCfg } from './ton.js';
import * as solana from './solana.js';
import * as deposits from './deposits.js';

// An on-demand chain scan costs an RPC round trip, so a player watching
// their deposit sheet gets one every few seconds, not one per poll.
const lastScan = new Map();
const SCAN_EVERY_MS = 6000;
function scanAllowed(uname, now = Date.now()) {
  const prev = lastScan.get(uname) || 0;
  if (now - prev < SCAN_EVERY_MS) return false;
  lastScan.set(uname, now);
  if (lastScan.size > 5000) for (const [k, t] of lastScan) if (now - t > 60e3) lastScan.delete(k);
  return true;
}

const tx = (ctx, fn) => wallet.withClient(ctx.pool, fn);

// admin identity lives in the JSON blob (ctx.db), not the ledger — used to fan
// out review notifications (new dispute, etc.)
const adminUsers = ctx => (ctx.db && ctx.db.users ? Object.values(ctx.db.users) : []).filter(u => u.isAdmin);
const userByName = (ctx, uname) => (ctx.db && ctx.db.users ? Object.values(ctx.db.users) : []).find(u => u.username === uname);
// The ledger keys people by @username; notify() wants a Telegram id. Anything
// money-related has to tell the person, so bridge the two in one place.
const notifyUser = (ctx, uname, text) => { const u = userByName(ctx, uname); if (u && ctx.notify) ctx.notify(u.id, text); };

// tell a rejected hunter, and point out they can appeal (LEDGER reject was silent before)
async function notifyDecision(ctx, pool, subId, reason) {
  if (!ctx.notify) return;
  const s = (await pool.query(
    `SELECT s.hunter_id, d.code FROM submissions s JOIN dares d ON d.id=s.dare_id WHERE s.id=$1`, [subId])).rows[0];
  const hunter = s && userByName(ctx, s.hunter_id);
  if (hunter) ctx.notify(hunter.id,
    `❌ Your proof for ${s.code} was rejected.\nReason: ${reason}\nYou can record a fresh proof, or appeal this once from your profile.`);
}
// tell the hunter how their appeal went
async function notifyDispute(ctx, pool, subId, upheld) {
  if (!ctx.notify) return;
  const s = (await pool.query(
    `SELECT s.hunter_id, d.code FROM submissions s JOIN dares d ON d.id=s.dare_id WHERE s.id=$1`, [subId])).rows[0];
  const hunter = s && userByName(ctx, s.hunter_id);
  if (!hunter) return;
  ctx.notify(hunter.id, upheld
    ? `⚖️ Your appeal on ${s.code} was reviewed — the rejection stands. This decision is final.`
    : `🏆 Your appeal on ${s.code} was upheld — your proof was approved and the bounty paid out! 🎉`);
}

async function winnersOf(pool, dareId) {
  const r = await pool.query(
    `SELECT hunter_id AS player, EXTRACT(EPOCH FROM created_at)*1000 AS at
       FROM submissions WHERE dare_id=$1 AND status='approved' ORDER BY created_at ASC`, [dareId]);
  return r.rows.map(x => ({ player: x.player, at: Number(x.at) }));
}

export async function ledgerApi(ctx) {
  const { method, path: p, user, pool, json, res } = ctx;
  // server.js lets the two public dare GETs through without a session, so the
  // viewer can be nobody. wallet.listDares/reactionsFor already default their
  // viewer to null and a SQL comparison against NULL simply matches no rows,
  // so an anonymous reader gets the dare with none of the "did I react / did I
  // already submit" state attached — which is exactly right.
  const uname = user ? user.username : null;

  // ----- balance / me -----
  if (p === '/api/me' && method === 'GET') {
    json(res, 200, { user: { id: user.id, username: uname, name: user.name,
      credits: await wallet.balance(pool, uname), wins: user.wins || 0,
      isAdmin: !!user.isAdmin, banned: !!user.banned },
      // Same field the JSON path returns — the app builds its share link from it.
      appLink: process.env.APP_LINK || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL + '/app' : '') });
    return true;
  }

  // ----- my activity -----
  if (p === '/api/me/activity' && method === 'GET') {
    const challenges = (await wallet.listDares(pool)).filter(d => d.creator === uname);
    const now = Date.now();
    const subs = (await pool.query(
      `SELECT s.*, d.code, d.title,
              (d.status='open' AND (SELECT count(*) FROM submissions x WHERE x.dare_id=d.id AND x.status='approved') < d.max_winners) AS slot_free
         FROM submissions s JOIN dares d ON d.id=s.dare_id
        WHERE s.hunter_id=$1 ORDER BY s.created_at DESC`, [uname])).rows
      .map(s => {
        const decidedAt = s.decided_at ? new Date(s.decided_at).getTime() : null;
        // the hunter may appeal a fresh rejection once, while a slot is still free
        const canAppeal = s.status === 'rejected' && !s.appealed_at && s.slot_free &&
          (decidedAt == null || now - decidedAt <= wallet.APPEAL_WINDOW_MS);
        return { id: Number(s.id), code: s.code, title: s.title, file: s.file, video: s.video,
          hasVideo: !!s.video, status: s.status, reason: s.reason, canAppeal,
          at: s.created_at ? new Date(s.created_at).getTime() : 0 };
      });
    const txns = (await wallet.recentTxns(pool, 200))
      .filter(t => t.entries.some(e => e.account === 'user:' + uname)).slice(0, 30);
    json(res, 200, { challenges, submissions: subs, txns });
    return true;
  }

  // ----- list challenges -----
  if (p === '/api/challenges' && method === 'GET') {
    // viewer so each slide knows whether this person already reacted
    json(res, 200, { challenges: (await wallet.listDares(pool, { viewer: uname })).map(d => ({ ...d, winners: [] })) });
    return true;
  }

  // ----- single challenge detail -----
  let m = p.match(/^\/api\/challenges\/(\d+)$/);
  if (m && method === 'GET') {
    const d = (await wallet.listDares(pool, { viewer: uname })).find(x => x.id === Number(m[1]));
    if (!d) { json(res, 404, { error: 'not found' }); return true; }
    d.winners = await winnersOf(pool, d.id);
    const mine = await pool.query(
      `SELECT 1 FROM submissions WHERE dare_id=$1 AND hunter_id=$2 AND status<>'rejected' LIMIT 1`, [d.id, uname]);
    d.mySubmission = mine.rows.length > 0;
    // The sheet is where a conversation fits; the slide only carries counts.
    d.reactionSet = wallet.REACTIONS;
    d.reactionCounts = (await wallet.reactionsFor(pool, d.id, uname)).counts;
    d.commentList = await wallet.commentsFor(pool, d.id);
    json(res, 200, { challenge: d });
    return true;
  }

  // ----- reactions -----
  // One tap toggles. Sending the same emoji again clears it, a different one
  // switches, and an explicit null removes — all one row per person per dare.
  let rx = p.match(/^\/api\/challenges\/(\d+)\/react$/);
  if (rx && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const want = (ctx.body || {}).emoji ?? null;
    try {
      const cur = await wallet.reactionsFor(pool, rx[1], uname);
      const next = (want !== null && cur.mine === want) ? null : want;
      json(res, 200, await wallet.react(pool, { dareId: rx[1], userId: uname, emoji: next }));
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // ----- comments -----
  let cm = p.match(/^\/api\/challenges\/(\d+)\/comments$/);
  if (cm && method === 'GET') {
    json(res, 200, { comments: await wallet.commentsFor(pool, cm[1]), max: wallet.COMMENT_MAX });
    return true;
  }
  if (cm && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    try {
      const c = await wallet.addComment(pool, { dareId: cm[1], userId: uname, body: (ctx.body || {}).body });
      // Tell the creator somebody is talking about their dare — but not when
      // they are the one talking, and never for their own reply to themselves.
      const d = (await wallet.listDares(pool)).find(x => x.id === Number(cm[1]));
      if (d && d.creator && d.creator !== uname)
        notifyUser(ctx, d.creator, `💬 @${uname} commented on your dare ${d.code}:\n"${c.body.slice(0, 140)}"`);
      json(res, 200, { comment: c });
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // Author or admin only, enforced in wallet.deleteComment. Soft delete, so a
  // reported comment survives for whoever has to look at the report.
  // POST rather than DELETE: every other mutation here is a POST, the CORS
  // policy only advertises GET/POST/OPTIONS, and the body parser only runs for
  // POST. One odd verb would be the only thing on this server needing all three
  // widened.
  let cd = p.match(/^\/api\/comments\/(\d+)\/delete$/);
  if (cd && method === 'POST') {
    try { json(res, 200, await wallet.deleteComment(pool, cd[1], { by: uname, isAdmin: !!user.isAdmin })); }
    catch (e) { json(res, /not your comment/.test(e.message) ? 403 : 400, { error: e.message }); }
    return true;
  }

  // ----- create a dare -----
  if (p === '/api/challenges' && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const b = ctx.body || {};
    // Bounties are whole dollars. Flooring a typed 7.50 down to 7 silently
    // changed what the creator was posting, so say so instead.
    const rawReward = Number(b.reward);
    const reward = Math.max(0, Math.floor(rawReward || 0));
    const n = Math.max(1, Math.min(20, Math.floor(Number(b.maxWinners) || 1)));
    if (!b.title || !b.desc || reward < 1) { json(res, 400, { error: 'title, desc and reward required' }); return true; }
    if (Number.isFinite(rawReward) && rawReward !== reward) {
      json(res, 400, { error: 'bounties are whole dollars — use $' + reward + ' or $' + (reward + 1) }); return true;
    }
    // A deadline is the only thing that gets the creator's escrow back if the
    // dare is never completed, so it defaults on (DARE_TTL_DAYS, 0 = never).
    const defTtl = Number(process.env.DARE_TTL_DAYS ?? 14);
    const days = b.expiresInDays == null ? (defTtl > 0 ? defTtl : null) : Number(b.expiresInDays);
    try {
      const r = await tx(ctx, c => wallet.createDare(c, { creatorId: uname,
        title: b.title, desc: b.desc, rules: b.rules, rewardUsdt: reward, maxWinners: n,
        expiresInDays: days }));
      json(res, 200, { ok: true, code: r.code, locked: r.lockedUsdt, expiresAt: r.expiresAt,
        credits: await wallet.balance(pool, uname) });
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // ----- submit proof (real video or filename) -----
  m = p.match(/^\/api\/challenges\/(\d+)\/submit$/);
  if (m && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const dareId = Number(m[1]);
    const dr = await pool.query(`SELECT creator_id FROM dares WHERE id=$1`, [dareId]);
    if (!dr.rows.length) { json(res, 404, { error: 'not found' }); return true; }
    if (dr.rows[0].creator_id === uname) { json(res, 403, { error: "you can't complete your own dare" }); return true; }

    let videoName = null, fileLabel = '', vhash = null;
    if (ctx.files && ctx.files.video) {
      vhash = ctx.crypto.createHash('sha256').update(ctx.files.video.data).digest('hex');
      const dup = await pool.query(`SELECT 1 FROM submissions WHERE vhash=$1 AND status<>'rejected' LIMIT 1`, [vhash]);
      if (dup.rows.length) { json(res, 400, { error: 'this exact video was already submitted — record a fresh proof' }); return true; }
      const ext = (ctx.pathMod.extname(ctx.files.video.filename) || '.mp4').toLowerCase().slice(0, 6).replace(/[^.\w]/g, '');
      videoName = `sub_${Date.now()}_${ctx.crypto.randomBytes(8).toString('hex')}${ext}`;
      ctx.fs.writeFileSync(ctx.pathMod.join(ctx.UP_DIR, videoName), ctx.files.video.data);
      fileLabel = ctx.files.video.filename.slice(0, 120);
    } else { fileLabel = String((ctx.body && ctx.body.file) || 'video.mp4').slice(0, 120); }

    try {
      const r = await tx(ctx, c => wallet.submit(c, { dareId, hunterId: uname, vhash, file: fileLabel, video: videoName }));
      json(res, 200, { ok: true, submissionId: r.submissionId, hasVideo: !!videoName });
      // tell the creator someone is going for their bounty (same as the JSON path)
      const d = (await pool.query(`SELECT code, title, creator_id FROM dares WHERE id=$1`, [dareId])).rows[0];
      const creator = d && ctx.db && Object.values(ctx.db.users).find(x => x.username === d.creator_id);
      if (creator && creator.id !== user.id && ctx.notify)
        ctx.notify(creator.id, `🎬 New proof on your dare ${d.code} — "${d.title}"\nfrom @${uname}. Someone's going for your bounty!`);
    } catch (e) {
      // the guard rejected us — don't leave the uploaded file orphaned on disk
      if (videoName) { try { ctx.fs.unlinkSync(ctx.pathMod.join(ctx.UP_DIR, videoName)); } catch (_) {} }
      json(res, 400, { error: e.message });
    }
    return true;
  }

  // ----- appeal a rejected proof (hunter must own it) -----
  m = p.match(/^\/api\/submissions\/(\d+)\/appeal$/);
  if (m && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const subId = Number(m[1]);
    const owns = await pool.query(`SELECT hunter_id FROM submissions WHERE id=$1`, [subId]);
    if (!owns.rows.length) { json(res, 404, { error: 'not found' }); return true; }
    if (owns.rows[0].hunter_id !== uname) { json(res, 403, { error: 'not your proof' }); return true; }
    try {
      await tx(ctx, c => wallet.appeal(c, subId));
      json(res, 200, { ok: true });
      // let the review team know a decision is being contested
      const d = (await pool.query(
        `SELECT d.code, d.title FROM submissions s JOIN dares d ON d.id=s.dare_id WHERE s.id=$1`, [subId])).rows[0];
      if (d) for (const a of adminUsers(ctx))
        ctx.notify?.(a.id, `⚖️ @${uname} appealed a rejected proof on ${d.code} — "${d.title}". It needs a second look.`);
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // ----- leaderboard -----
  if (p === '/api/leaderboard' && method === 'GET') {
    // ADMIN_IDS is Telegram ids; ledger accounts are keyed by username. The
    // JSON user map is the only place that holds both, so the translation
    // happens here rather than inside the query.
    const exclude = Object.values(ctx.db?.users || {})
      .filter(u => u.isAdmin && u.username).map(u => u.username);
    json(res, 200, { leaderboard: (await wallet.leaderboard(pool, { exclude })).map(x => ({ username: x.username, wins: x.wins, earned: x.earnedUsdt })) });
    return true;
  }

  // ----- wallet info: where/how to deposit (address + comment = your username) -----
  if (p === '/api/wallet/info' && method === 'GET') {
    const c = tonCfg();
    let sol = null;
    try {
      const sc = solana.cfg();
      if (sc.configured) sol = { network: sc.network, address: await solana.allocateAddress(pool, uname), mint: sc.usdcMint, min: sc.minDeposit };
    } catch (e) { /* solana off or not ready — omit */ }
    json(res, 200, { network: c.network, address: c.deposit, comment: uname,
      configured: c.configured, jetton: c.jetton, sol,
      balance: await wallet.balance(pool, uname) });
    return true;
  }

  // ----- my own deposit history (powers the wallet history strip) -----
  if (p === '/api/wallet/deposits' && method === 'GET') {
    json(res, 200, { deposits: await wallet.userDeposits(pool, uname, 20) });
    return true;
  }

  // ----- transfers of mine currently in flight, with how confirmed they are.
  // This is what turns the deposit sheet from "waiting…" into a live state. -----
  if (p === '/api/wallet/pending' && method === 'GET') {
    const rows = await deposits.pendingFor(pool, uname);
    json(res, 200, {
      pending: rows.map(r => ({
        chain: r.chain, ref: r.txref, amount: r.amountUsdt, status: r.status,
        confirms: r.confirms, need: r.need, detail: r.detail,
        at: r.firstSeen, text: deposits.progressText(r),
      })),
    });
    return true;
  }

  // ----- "look now": scan the chain for THIS player's address on demand,
  // so a transfer is picked up in seconds rather than on the next sweep. -----
  if (p === '/api/wallet/scan' && method === 'POST') {
    if (!scanAllowed(uname)) { json(res, 200, { scanned: false, reason: 'just looked' }); return true; }
    const out = { scanned: true };
    try {
      if (solana.cfg().configured) {
        const r = await solana.pollAddresses(pool, { usernames: [uname], limit: 5 });
        out.solana = { seen: r.seen || 0, credited: r.credited || 0 };
      }
      // TON shares one address across everyone, so the sweep is global —
      // but running the confirmation pass here still settles this player's
      // transfer the moment it is deep enough.
      if (tonCfg().configured) {
        const r = await ton.pollDeposits(pool, { error: () => {}, warn: () => {}, log: () => {} });
        out.ton = { credited: r.credited || 0, confirming: r.confirming || 0 };
      }
    } catch (e) { out.error = 'scan failed'; }
    json(res, 200, out);
    return true;
  }

  // ----- deposit (admin-triggered, e.g. after confirming a TON testnet transfer) -----
  if (p === '/api/wallet/deposit' && method === 'POST') {
    if (!user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const b = ctx.body || {};
    const amt = Number(b.usdt); if (!(amt > 0)) { json(res, 400, { error: 'bad amount' }); return true; }
    const who = b.username || uname;
    try {
      await tx(ctx, c => wallet.deposit(c, who, amt, b.txhash || null));
      json(res, 200, { ok: true, balance: await wallet.balance(pool, who) });
    } catch (e) {
      const dup = /duplicate key|unique|uniq_deposit_ref/i.test(e.message);
      json(res, 400, { error: dup ? 'this txhash was already credited' : e.message });
    }
    return true;
  }

  // ----- withdrawals: request, review, send -----
  //
  // Every withdrawal waits for a human. That is a deliberate choice, not a
  // missing feature: the server holds the mnemonic for the whole float, so
  // any bug that lets a request name its own destination is a direct drain.
  // A reviewer between the request and the send is the thing that turns that
  // from "everything is gone" into "somebody noticed".
  //
  // The money leaves the user's spendable balance at request time, so nobody
  // can queue a payout and spend the same balance on a dare while it waits.

  if (p === '/api/wallet/withdraw' && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const b = ctx.body || {};
    const amt = Number(b.usdt);
    if (!(amt > 0)) { json(res, 400, { error: 'bad amount' }); return true; }
    try {
      const r = await tx(ctx, c => wallet.requestWithdrawal(c, {
        userId: uname, usdt: amt, chain: String(b.chain || 'ton'), address: b.address }));
      for (const a of adminUsers(ctx))
        ctx.notify?.(a.id, `💸 Withdrawal request #${r.id} — @${uname} wants $${r.net} out on ${String(b.chain).toUpperCase()}.\nReview it in the dashboard.`);
      json(res, 200, { ok: true, ...r, balance: await wallet.balance(pool, uname) });
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  if (p === '/api/wallet/withdrawals' && method === 'GET') {
    json(res, 200, { withdrawals: await wallet.userWithdrawals(pool, uname),
      min: wallet.WITHDRAW_MIN, feeBps: wallet.WITHDRAW_FEE_BPS });
    return true;
  }

  if ((p === '/api/admin/withdrawals' || p === '/api/dash/withdrawals') && method === 'GET') {
    if (p.startsWith('/api/admin') && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    json(res, 200, { withdrawals: await wallet.pendingWithdrawals(pool) });
    return true;
  }

  let wm;
  if ((wm = p.match(/^\/api\/(admin|dash)\/withdraw\/(\d+)\/(approve|reject)$/)) && method === 'POST') {
    if (wm[1] === 'admin' && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const id = Number(wm[2]);
    const w = await wallet.getWithdrawal(pool, id);
    if (!w) { json(res, 404, { error: 'no such withdrawal' }); return true; }
    if (w.status !== 'requested') { json(res, 400, { error: `already ${w.status}` }); return true; }

    if (wm[3] === 'reject') {
      const reason = String((ctx.body || {}).reason || '').trim() || 'declined by review';
      await tx(ctx, c => wallet.cancelWithdrawal(c, id, { status: 'rejected', reason }));
      notifyUser(ctx, w.user, `Your withdrawal of $${w.net} was declined.\n${reason}\nThe full $${w.gross} is back in your balance.`);
      json(res, 200, { ok: true });
      return true;
    }

    // Approve = actually send. Order matters: the chain call happens first and
    // only a confirmed send settles the ledger. If the send throws, the reserve
    // goes back to the user and nothing was lost but time.
    let sent;
    try {
      const mod = w.chain === 'ton' ? await import('./ton.js') : await import('./solana.js');
      sent = w.chain === 'ton'
        ? await mod.sendUsdt({ toAddress: w.address, amountUsdt: w.net })
        : await mod.sendUsdc({ toAddress: w.address, amountUsdc: w.net });
    } catch (e) {
      // The send never landed, so the fee was never earned — cancelWithdrawal
      // returns the gross, fee included.
      await tx(ctx, c => wallet.cancelWithdrawal(c, id, { status: 'failed', reason: e.message }));
      notifyUser(ctx, w.user, `Your withdrawal could not be sent: ${e.message}\nThe full $${w.gross} is back in your balance.`);
      json(res, 502, { error: 'send failed — funds returned: ' + e.message });
      return true;
    }
    const ref = sent.ref || sent.signature || sent.txhash;
    try {
      await tx(ctx, c => wallet.settleWithdrawal(c, id, ref));
    } catch (e) {
      // The worst case, and the one worth shouting about: the money is gone
      // from the chain but the books still show it reserved. Left in
      // 'requested' on purpose so it is visible and fixable by hand rather
      // than quietly reconciled into looking fine.
      console.error(`WITHDRAWAL ${id} SENT BUT NOT SETTLED ref=${ref}:`, e.message);
      for (const a of adminUsers(ctx))
        ctx.notify?.(a.id, `🚨 Withdrawal #${id} was SENT on-chain (${ref}) but the ledger write failed: ${e.message}\nDo not re-send. Settle it by hand.`);
      json(res, 500, { error: 'sent on-chain but the ledger did not settle — do not retry, see logs' });
      return true;
    }
    notifyUser(ctx, w.user, `✅ $${w.net} is on its way to your ${w.chain === 'ton' ? 'TON' : 'Solana'} wallet.`);
    json(res, 200, { ok: true, ref });
    return true;
  }

  // ----- admin / dashboard review queue + actions -----
  const admin = p.startsWith('/api/admin');
  if ((p === '/api/admin/queue' || p === '/api/dash/queue') && method === 'GET') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    json(res, 200, { queue: await wallet.adminQueue(pool) });
    return true;
  }
  m = p.match(/^\/api\/(?:admin|dash)\/approve\/(\d+)$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    try { const r = await tx(ctx, c => wallet.approve(c, Number(m[1]))); json(res, 200, { ok: true, winner: true, ...r }); }
    catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  m = p.match(/^\/api\/(?:admin|dash)\/reject\/(\d+)$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const reason = String((ctx.body && ctx.body.reason) || '').slice(0, 200);
    if (!reason) { json(res, 400, { error: 'reason required' }); return true; }
    try {
      await tx(ctx, c => wallet.reject(c, Number(m[1]), reason));
      json(res, 200, { ok: true });
      await notifyDecision(ctx, pool, Number(m[1]), reason);
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  // ----- disputes: the queue + a second reviewer's decision -----
  if ((p === '/api/admin/disputes' || p === '/api/dash/disputes') && method === 'GET') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    json(res, 200, { disputes: await wallet.disputeQueue(pool) });
    return true;
  }
  m = p.match(/^\/api\/(?:admin|dash)\/dispute\/(\d+)\/resolve$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const uphold = !!(ctx.body && ctx.body.uphold);              // uphold the reject, or overturn → pay
    const reason = String((ctx.body && ctx.body.reason) || '').slice(0, 200);
    try {
      const r = await tx(ctx, c => wallet.resolveDispute(c, Number(m[1]), { uphold, reason }));
      json(res, 200, { ok: true, ...r });
      await notifyDispute(ctx, pool, Number(m[1]), r.upheld);
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  m = p.match(/^\/api\/(?:admin|dash)\/challenge\/(\d+)\/delete$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    try { const r = await tx(ctx, c => wallet.refund(c, Number(m[1]))); json(res, 200, { ok: true, refunded: r.refunded / wallet.MICRO }); }
    catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  // Without this the edit fell through to server.js and wrote to the JSON blob,
  // which LEDGER mode never reads back — the change silently vanished.
  m = p.match(/^\/api\/(?:admin|dash)\/challenge\/(\d+)\/edit$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    try { await wallet.editDare(pool, Number(m[1]), ctx.body || {}); json(res, 200, { ok: true }); }
    catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // ===== dashboard / admin analytics (LEDGER-backed) =====
  // identity (banned/isAdmin/name/joinedAt) lives in the blob; money in the ledger.
  const isDash = p.startsWith('/api/dash/');
  const isAdminAnalytics = p.startsWith('/api/admin/') &&
    /(users|challenges|txns|deposits|health)$|\/(ban|credits)\//.test(p);
  if (isDash || isAdminAnalytics) {
    if (isAdminAnalytics && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const blobUsers = (ctx.db && ctx.db.users) ? Object.values(ctx.db.users) : [];

    async function usersView() {
      const out = [];
      for (const u of blobUsers) {
        const a = (await pool.query(
          `SELECT
             COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
                JOIN accounts ac ON ac.id=e.account_id
               WHERE t.type='payout' AND ac.kind='user' AND ac.owner_id=$1 AND e.amount>0),0) AS earned,
             (SELECT count(*) FROM submissions s WHERE s.hunter_id=$1 AND s.status='approved')::int AS wins,
             (SELECT count(*) FROM dares d WHERE d.creator_id=$1)::int AS posted,
             (SELECT count(*) FROM submissions s WHERE s.hunter_id=$1)::int AS subs`, [u.username])).rows[0];
        out.push({ id: u.id, username: u.username, name: u.name,
          credits: await wallet.balance(pool, u.username), wins: a.wins,
          banned: !!u.banned, isAdmin: !!u.isAdmin, earned: Number(a.earned) / wallet.MICRO,
          joinedAt: u.joinedAt, posted: a.posted, subs: a.subs });
      }
      return out.sort((x, y) => (y.joinedAt || 0) - (x.joinedAt || 0));
    }

    async function txnsView() {
      const r = await pool.query(`
        SELECT t.id, t.type, t.ref, EXTRACT(EPOCH FROM t.created_at)*1000 AS at,
          (SELECT ac.kind||CASE WHEN ac.owner_id<>'' THEN ':'||ac.owner_id ELSE '' END
             FROM ledger_entries e JOIN accounts ac ON ac.id=e.account_id WHERE e.tx_id=t.id ORDER BY e.amount ASC  LIMIT 1) AS frm,
          (SELECT ac.kind||CASE WHEN ac.owner_id<>'' THEN ':'||ac.owner_id ELSE '' END
             FROM ledger_entries e JOIN accounts ac ON ac.id=e.account_id WHERE e.tx_id=t.id ORDER BY e.amount DESC LIMIT 1) AS too,
          (SELECT MAX(e.amount) FROM ledger_entries e WHERE e.tx_id=t.id) AS amount
        FROM ledger_tx t ORDER BY t.id DESC LIMIT 300`);
      return r.rows.map(x => ({ id: Number(x.id), at: Number(x.at), type: x.type,
        from: x.frm, to: x.too, amount: Number(x.amount) / wallet.MICRO, note: x.ref || '' }));
    }

    async function depositsView() {
      const r = await pool.query(`
        SELECT t.id, t.ref, EXTRACT(EPOCH FROM t.created_at)*1000 AS at,
          (SELECT ac.owner_id FROM ledger_entries e JOIN accounts ac ON ac.id=e.account_id
             WHERE e.tx_id=t.id AND ac.kind='user' AND e.amount>0 LIMIT 1) AS username,
          (SELECT MAX(e.amount) FROM ledger_entries e WHERE e.tx_id=t.id) AS amount
        FROM ledger_tx t WHERE t.type='deposit' ORDER BY t.id DESC LIMIT 300`);
      return r.rows.map(x => ({ id: Number(x.id), at: Number(x.at),
        username: x.username || '', amount: Number(x.amount) / wallet.MICRO,
        ref: x.ref || '', source: (String(x.ref || '').startsWith('admin-set') ? 'admin' : 'on-chain') }));
    }

    async function overview() {
      const dares = await wallet.listDares(pool);
      const open = dares.filter(d => !d.full).length;
      const q = (await pool.query(`
        SELECT
          (SELECT count(*) FROM submissions)::int AS subs,
          (SELECT count(*) FROM submissions WHERE status='pending')::int AS pending,
          (SELECT count(*) FROM submissions WHERE status='approved')::int AS approved,
          (SELECT count(*) FROM submissions WHERE status='rejected')::int AS rejected,
          (SELECT count(*) FROM ledger_tx)::int AS txc,
          COALESCE((SELECT SUM(balance) FROM accounts WHERE kind='user'),0) AS inplay,
          COALESCE((SELECT SUM(balance) FROM accounts WHERE kind='platform_fees'),0) AS fees,
          COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
                      JOIN accounts ac ON ac.id=e.account_id
                      WHERE t.type='payout' AND ac.kind='user' AND e.amount>0),0) AS paid,
          COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
                      WHERE t.type='refund' AND e.amount>0),0) AS refunded`)).rows[0];
      const DAY = 86400e3, days = 14, today = new Date(); today.setHours(0,0,0,0);
      const start = today.getTime() - (days - 1) * DAY;
      const labels = [], dd = [], pp = [];
      const dRows = (await pool.query(`SELECT EXTRACT(EPOCH FROM created_at)*1000 AS at FROM dares`)).rows.map(x=>Number(x.at));
      const sRows = (await pool.query(`SELECT EXTRACT(EPOCH FROM created_at)*1000 AS at FROM submissions`)).rows.map(x=>Number(x.at));
      for (let i = 0; i < days; i++) { const d0 = start + i*DAY, d1 = d0+DAY; const dt = new Date(d0);
        labels.push((dt.getMonth()+1)+'/'+dt.getDate());
        dd.push(dRows.filter(a=>a>=d0&&a<d1).length); pp.push(sRows.filter(a=>a>=d0&&a<d1).length); }
      const rewardPool = dares.filter(d=>!d.full).reduce((a,d)=>a+d.reward*d.maxWinners,0);
      const fees = Number(q.fees)/wallet.MICRO, paidOut = Number(q.paid)/wallet.MICRO, refunded = Number(q.refunded)/wallet.MICRO;
      return { users: blobUsers.length, banned: blobUsers.filter(u=>u.banned).length,
        challenges: dares.length, open, filled: dares.length - open,
        submissions: q.subs, pending: q.pending, approved: q.approved, rejected: q.rejected,
        rewardPool, paidOut, fees, refunded, creditsInPlay: Number(q.inplay)/wallet.MICRO, txnsCount: q.txc,
        charts: { activity: { labels, dares: dd, proofs: pp }, flows: { paidOut, fees, refunded },
                  proofStatus: { approved: q.approved, rejected: q.rejected, pending: q.pending } } };
    }

    // ledger.js has shipped conservation/reconcile/liabilities from day one but
    // nothing ever called them. This is the endpoint to alert on: if `ok` goes
    // false, the books no longer balance and payouts should stop.
    async function health() {
      const [conservation, drift, liabilitiesUsdt] = await Promise.all([
        wallet.conservation(pool), wallet.reconcile(pool), wallet.liabilities(pool),
      ]);
      // the escrow account must equal what the open dares still say they hold
      const e = (await pool.query(
        `SELECT COALESCE((SELECT balance FROM accounts WHERE kind='escrow' AND owner_id=''),0) AS acct,
                COALESCE((SELECT SUM(escrow_locked) FROM dares),0) AS locked`)).rows[0];
      const escrowAccount = Number(e.acct), escrowLocked = Number(e.locked);
      const escrowMatches = escrowAccount === escrowLocked;
      return {
        ok: conservation === 0 && drift.length === 0 && escrowMatches,
        conservation,                       // must be 0: money is neither created nor destroyed
        drift,                              // must be []: cached balances match the journal
        escrowMatches,
        escrowAccountUsdt: escrowAccount / wallet.MICRO,
        escrowLockedUsdt: escrowLocked / wallet.MICRO,
        liabilitiesUsdt,                    // the minimum reserve we must actually hold on-chain
      };
    }

    if (p.endsWith('/health')     && method === 'GET') {
      const h = await health();
      json(res, h.ok ? 200 : 500, { health: h });
      return true;
    }
    if (p.endsWith('/overview')   && method === 'GET') { json(res, 200, { overview: await overview() }); return true; }
    if (p.endsWith('/users')      && method === 'GET') { json(res, 200, { users: await usersView() }); return true; }
    if (p.endsWith('/txns')       && method === 'GET') { json(res, 200, { txns: await txnsView() }); return true; }
    if (p.endsWith('/deposits')   && method === 'GET') { json(res, 200, { deposits: await depositsView() }); return true; }
    if (p.endsWith('/challenges') && method === 'GET') { json(res, 200, { challenges: await wallet.listDares(pool) }); return true; }

    let dm;
    if ((dm = p.match(/\/ban\/([^/]+)$/)) && method === 'POST') {
      const tu = ctx.db && ctx.db.users[decodeURIComponent(dm[1])];
      if (!tu) { json(res, 404, { error: 'user not found' }); return true; }
      if (tu.isAdmin) { json(res, 400, { error: "can't ban an admin" }); return true; }
      tu.banned = !tu.banned; if (ctx.save) ctx.save();
      json(res, 200, { ok: true, banned: tu.banned }); return true;
    }
    if ((dm = p.match(/\/credits\/([^/]+)$/)) && method === 'POST') {
      const tu = ctx.db && ctx.db.users[decodeURIComponent(dm[1])];
      if (!tu) { json(res, 404, { error: 'user not found' }); return true; }
      const target = Math.max(0, Math.floor(Number((ctx.body || {}).credits)));
      if (!Number.isFinite(target)) { json(res, 400, { error: 'bad value' }); return true; }
      const cur = await wallet.balance(pool, tu.username);
      const delta = target - cur;
      // ref must be unique per call: uniq_deposit_ref / uniq_withdraw_ref are
      // partial unique indexes on ledger_tx(ref), so a constant 'admin-set'
      // would let this succeed exactly once for the whole database.
      const ref = 'admin-set:' + ctx.crypto.randomUUID();
      try {
        if (delta > 0) await tx(ctx, c => wallet.deposit(c, tu.username, delta, ref));
        else if (delta < 0) await tx(ctx, c => wallet.withdraw(c, tu.username, -delta, ref));
      } catch (e) { json(res, 400, { error: e.message }); return true; }
      json(res, 200, { ok: true, credits: target }); return true;
    }
  }

  return false; // not a money/dare route → let server.js handle it
}
