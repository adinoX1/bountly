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

const tx = (ctx, fn) => wallet.withClient(ctx.pool, fn);

async function winnersOf(pool, dareId) {
  const r = await pool.query(
    `SELECT hunter_id AS player, EXTRACT(EPOCH FROM created_at)*1000 AS at
       FROM submissions WHERE dare_id=$1 AND status='approved' ORDER BY created_at ASC`, [dareId]);
  return r.rows.map(x => ({ player: x.player, at: Number(x.at) }));
}

export async function ledgerApi(ctx) {
  const { method, path: p, user, pool, json, res } = ctx;
  const uname = user.username;

  // ----- balance / me -----
  if (p === '/api/me' && method === 'GET') {
    json(res, 200, { user: { id: user.id, username: uname, name: user.name,
      credits: await wallet.balance(pool, uname), wins: user.wins || 0,
      isAdmin: !!user.isAdmin, banned: !!user.banned } });
    return true;
  }

  // ----- my activity -----
  if (p === '/api/me/activity' && method === 'GET') {
    const challenges = (await wallet.listDares(pool)).filter(d => d.creator === uname);
    const subs = (await pool.query(
      `SELECT s.*, d.code, d.title FROM submissions s JOIN dares d ON d.id=s.dare_id
        WHERE s.hunter_id=$1 ORDER BY s.created_at DESC`, [uname])).rows
      .map(s => ({ id: Number(s.id), code: s.code, title: s.title, file: s.file, video: s.video,
        hasVideo: !!s.video, status: s.status, reason: s.reason,
        at: s.created_at ? new Date(s.created_at).getTime() : 0 }));
    const txns = (await wallet.recentTxns(pool, 200))
      .filter(t => t.entries.some(e => e.account === 'user:' + uname)).slice(0, 30);
    json(res, 200, { challenges, submissions: subs, txns });
    return true;
  }

  // ----- list challenges -----
  if (p === '/api/challenges' && method === 'GET') {
    json(res, 200, { challenges: (await wallet.listDares(pool)).map(d => ({ ...d, winners: [] })) });
    return true;
  }

  // ----- single challenge detail -----
  let m = p.match(/^\/api\/challenges\/(\d+)$/);
  if (m && method === 'GET') {
    const d = (await wallet.listDares(pool)).find(x => x.id === Number(m[1]));
    if (!d) { json(res, 404, { error: 'not found' }); return true; }
    d.winners = await winnersOf(pool, d.id);
    const mine = await pool.query(
      `SELECT 1 FROM submissions WHERE dare_id=$1 AND hunter_id=$2 AND status<>'rejected' LIMIT 1`, [d.id, uname]);
    d.mySubmission = mine.rows.length > 0;
    json(res, 200, { challenge: d });
    return true;
  }

  // ----- create a dare -----
  if (p === '/api/challenges' && method === 'POST') {
    if (user.banned) { json(res, 403, { error: 'banned' }); return true; }
    const b = ctx.body || {};
    const reward = Math.max(0, Math.floor(Number(b.reward) || 0));
    const n = Math.max(1, Math.min(20, Math.floor(Number(b.maxWinners) || 1)));
    if (!b.title || !b.desc || reward < 1) { json(res, 400, { error: 'title, desc and reward required' }); return true; }
    try {
      const r = await tx(ctx, c => wallet.createDare(c, { creatorId: uname,
        title: b.title, desc: b.desc, rules: b.rules, rewardUsdt: reward, maxWinners: n }));
      json(res, 200, { ok: true, code: r.code, locked: r.lockedUsdt, credits: await wallet.balance(pool, uname) });
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
    } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  // ----- leaderboard -----
  if (p === '/api/leaderboard' && method === 'GET') {
    json(res, 200, { leaderboard: (await wallet.leaderboard(pool)).map(x => ({ username: x.username, wins: x.wins, earned: x.earnedUsdt })) });
    return true;
  }

  // ----- deposit (admin-triggered, e.g. after confirming a TON testnet transfer) -----
  if (p === '/api/wallet/deposit' && method === 'POST') {
    if (!user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    const b = ctx.body || {};
    const amt = Number(b.usdt); if (!(amt > 0)) { json(res, 400, { error: 'bad amount' }); return true; }
    const who = b.username || uname;
    await tx(ctx, c => wallet.deposit(c, who, amt, b.txhash || null));
    json(res, 200, { ok: true, balance: await wallet.balance(pool, who) });
    return true;
  }

  // ----- withdraw (records the ledger side AFTER the on-chain send succeeds) -----
  if (p === '/api/wallet/withdraw' && method === 'POST') {
    const b = ctx.body || {};
    const amt = Number(b.usdt); if (!(amt > 0)) { json(res, 400, { error: 'bad amount' }); return true; }
    try {
      await tx(ctx, c => wallet.withdraw(c, uname, amt, b.txhash || null));
      json(res, 200, { ok: true, balance: await wallet.balance(pool, uname) });
    } catch (e) { json(res, 400, { error: e.message }); }
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
    try { await tx(ctx, c => wallet.reject(c, Number(m[1]), reason)); json(res, 200, { ok: true }); }
    catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  m = p.match(/^\/api\/(?:admin|dash)\/challenge\/(\d+)\/delete$/);
  if (m && method === 'POST') {
    if (admin && !user.isAdmin) { json(res, 403, { error: 'admin only' }); return true; }
    try { const r = await tx(ctx, c => wallet.refund(c, Number(m[1]))); json(res, 200, { ok: true, refunded: r.refunded / wallet.MICRO }); }
    catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }

  return false; // not a money/dare route → let server.js handle it
}
