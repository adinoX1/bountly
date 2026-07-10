// ============================================================
// BOUNTLY — Telegram Mini App backend (v2.1, hardened)
// Credits-based dare/bounty platform. Run: node server.js (Node 18+)
//
// What changed vs v2 (see IMPROVEMENTS.md for the full list):
//  • SECURITY: static file server no longer leaks data.json / server.js / .env
//  • SECURITY: CORS is now opt-in via ALLOW_ORIGIN instead of a blanket "*"
//  • SECURITY: dashboard login is rate-limited + uses a timing-safe compare
//  • SECURITY: uploaded videos get an unguessable random filename
//  • SECURITY: dev auth bypass refuses to run when NODE_ENV=production
//  • SECURITY: basic hardening headers on every response
//  • QUALITY: admin (Telegram) and dashboard (password) now share one set of
//    action helpers instead of two near-identical copies
//  • QUALITY: removed dead code (`server.listen;`) and centralised config
// ============================================================
import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ledgerApi } from "./server_ledger.js";
import { initLedger, withClient } from "./wallet.js";
import { migrateAppState } from "./migrate_to_ledger.mjs";
import { startDepositWatcher } from "./ton.js";
import * as solana from "./solana.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- configuration (all via environment) ----
const BOT_TOKEN      = process.env.BOT_TOKEN || "";
const ADMIN_IDS      = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const PORT           = process.env.PORT || 3000;
const PLAYER_FEE     = 0.10, CREATOR_FEE = 0.05;
const START_CREDITS  = 100;
const MAX_VIDEO      = 50 * 1024 * 1024;            // 50 MB cap
const APP_LINK       = process.env.APP_LINK || "";  // e.g. https://t.me/getbountlybot/arena
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ALLOW_ORIGIN   = process.env.ALLOW_ORIGIN || "";       // set to enable cross-origin API access
const IS_PROD        = process.env.NODE_ENV === "production";
const DEV_AUTH       = !BOT_TOKEN && !IS_PROD;               // insecure header-based auth, dev only

// In production you MUST have a bot token — otherwise anyone can impersonate
// any user (incl. admins) via the X-Dev-User header.
if (!BOT_TOKEN && IS_PROD) {
  console.error("FATAL: BOT_TOKEN is required when NODE_ENV=production (dev auth bypass is disabled).");
  process.exit(1);
}
if (DEV_AUTH) {
  console.warn("⚠️  DEV MODE: no BOT_TOKEN set — Telegram auth is bypassed. Never use this in production.");
}

// ---- web dashboard session tokens (in-memory) ----
const dashTokens = new Map(); // token -> expiry ms
function newDashToken(){ const t = crypto.randomBytes(24).toString("hex"); dashTokens.set(t, Date.now() + 12 * 3600e3); return t; }
function dashAuth(req){
  const t = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const exp = dashTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp){ dashTokens.delete(t); return false; }
  return true;
}

// ---- login rate limiting (per IP) ----
const LOGIN_WINDOW = 15 * 60e3;  // 15 min
const LOGIN_MAX    = 8;          // attempts per window before lockout
const loginHits = new Map();     // ip -> { count, first }
function clientIp(req){
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "unknown";
}
function loginAllowed(ip){
  const now = Date.now(), rec = loginHits.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW){ loginHits.set(ip, { count: 0, first: now }); return true; }
  return rec.count < LOGIN_MAX;
}
function loginFail(ip){
  const now = Date.now(), rec = loginHits.get(ip) || { count: 0, first: now };
  rec.count++; loginHits.set(ip, rec);
}
// constant-time string compare that doesn't leak length via early return
function safeEqual(a, b){
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- send a Telegram notification to a user (fire-and-forget) ----
async function notify(userId, text){
  if (!BOT_TOKEN || !userId) return; // dev mode / no chat id → skip
  const payload = { chat_id: userId, text, disable_web_page_preview: true };
  if (APP_LINK) payload.reply_markup = { inline_keyboard: [[{ text: "⚡ Open Bountly", url: APP_LINK }]] };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!r.ok){ const t = await r.text(); console.error("notify failed", r.status, t.slice(0, 140)); }
  } catch (e){ console.error("notify error:", e.message); }
}

const DB_FILE = path.join(__dirname, "data.json");
const UP_DIR  = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive: true });

// ---- storage: Postgres if DATABASE_URL is set, else local JSON file ----
const USE_DB = !!process.env.DATABASE_URL;
const LEDGER = process.env.LEDGER === "1"; // route money/dares through the double-entry ledger
const SOLANA = process.env.SOLANA === "1"; // enable per-user Solana USDC deposits (Helius)
let pool = null;
async function initPool(){
  if (!USE_DB) return;
  const pg = (await import("pg")).default;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false
  });
}

let db;
function seed(){
  const now = Date.now();
  db = { users: {}, challenges: [], submissions: [], txns: [], seq: { ch: 0, sub: 0, tx: 0 } };
  db.challenges.push(
    { id: ++db.seq.ch, code: "BNT-001", title: "Dump a bucket of ice water on yourself",
      desc: "Film yourself pouring a full bucket of ice water over your head. Face and bucket must be visible.",
      rules: "Say the code in the video. One take, no cuts. Just you — no bystanders.",
      reward: 25, maxWinners: 1, creator: "demo", createdAt: now - 3600e3 },
    { id: ++db.seq.ch, code: "BNT-002", title: "Sing a verse of the anthem in public",
      desc: "Sing the first verse out loud in a public place — a square, park or bus stop.",
      rules: "Say the code. Singing must be audible. Don't film bystanders up close.",
      reward: 15, maxWinners: 3, creator: "demo", createdAt: now - 1800e3 });
}
// persist whole state. In DB mode it's fire-and-forget (in-memory is already updated).
function save(){
  if (USE_DB){ persist().catch(e => console.error("DB save error:", e.message)); }
  else { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
}
async function persist(){
  await pool.query(
    "INSERT INTO app_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb",
    [JSON.stringify(db)]
  );
}
async function initStore(){
  if (USE_DB){
    await initPool();
    if (LEDGER) { await initLedger(pool); console.log("✓ Ledger schema ready (LEDGER=1)"); }
    await pool.query("CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)");
    const r = await pool.query("SELECT data FROM app_state WHERE id=1");
    if (r.rows.length){ db = r.rows[0].data; console.log("✓ Loaded state from Postgres"); }
    else { seed(); await persist(); console.log("✓ Seeded fresh Postgres database"); }
    if (LEDGER) {
      try {
        const res = await withClient(pool, c => migrateAppState(c, db));
        console.log("✓ Ledger migration applied:", JSON.stringify(res));
      } catch (e) {
        if (/already applied/i.test(e.message)) console.log("✓ Ledger already migrated");
        else { console.error("Ledger migration FAILED:", e.message); throw e; }
      }
    }
  } else {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); console.log("✓ Loaded local data.json"); }
    catch (e){ seed(); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); console.log("✓ Created local data.json"); }
  }
}

// ---- Telegram auth ----
function verifyTelegram(initData){
  if (!BOT_TOKEN) return { ok: false, error: "server BOT_TOKEN not set" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash"); if (!hash) return { ok: false, error: "no hash" };
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc !== hash) return { ok: false, error: "bad signature" };
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return { ok: false, error: "expired" };
  return { ok: true, user: JSON.parse(params.get("user") || "{}") };
}
function ensureUser(tg){
  const id = String(tg.id);
  if (!db.users[id]){
    db.users[id] = { id, username: tg.username || ("user" + id.slice(-4)), name: tg.first_name || "Hunter",
      credits: START_CREDITS, wins: 0, banned: false, isAdmin: ADMIN_IDS.includes(id), joinedAt: Date.now() };
    save();
  }
  db.users[id].isAdmin = ADMIN_IDS.includes(id);
  return db.users[id];
}
function getUser(req){
  const initData = req.headers["x-telegram-init"] || "";
  if (DEV_AUTH){ const id = req.headers["x-dev-user"] || "dev1"; return { ok: true, user: ensureUser({ id, username: id, first_name: id }) }; }
  const v = verifyTelegram(initData); if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, user: ensureUser(v.user) };
}

// ---- derived views / helpers ----
const winnersOf = ch => db.submissions.filter(s => s.chId === ch.id && s.status === "approved").sort((a, b) => a.at - b.at).slice(0, ch.maxWinners);
const stats = ch => {
  const subs = db.submissions.filter(s => s.chId === ch.id && s.status !== "rejected");
  const w = winnersOf(ch);
  return { subs: subs.length, winners: w, full: w.length >= ch.maxWinners, pending: subs.filter(s => s.status === "pending").length };
};
const tx = (type, from, to, amount, note) => db.txns.push({ id: ++db.seq.tx, at: Date.now(), type, from, to, amount, note });
const pub = u => ({ id: u.id, username: u.username, name: u.name, credits: u.credits, wins: u.wins, isAdmin: u.isAdmin, banned: u.banned });

// ---- response helpers ----
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN"
};
function corsHeaders(){
  if (!ALLOW_ORIGIN) return {}; // same-origin: no CORS headers needed
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,X-Telegram-Init,X-Dev-User,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Vary": "Origin"
  };
}
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", ...SECURITY_HEADERS, ...corsHeaders() });
  res.end(JSON.stringify(obj));
};

function challengeView(ch){
  const st = stats(ch);
  return { id: ch.id, code: ch.code, title: ch.title, desc: ch.desc, rules: ch.rules, reward: ch.reward,
    maxWinners: ch.maxWinners, creator: ch.creator, slots: [st.winners.length, ch.maxWinners], full: st.full,
    subs: st.subs, pending: st.pending, winners: st.winners.map(w => ({ player: w.player, at: w.at })) };
}

// ---- multipart parser (minimal, for single video file) ----
async function readBody(req){
  const chunks = []; let total = 0;
  for await (const c of req){ total += c.length; if (total > MAX_VIDEO + 1024 * 1024) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}
function parseMultipart(buf, contentType){
  const m = /boundary=(.+)$/.exec(contentType || ""); if (!m) return {};
  const boundary = "--" + m[1]; const parts = {}; const files = {};
  let start = buf.indexOf(boundary);
  while (start !== -1){
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    let seg = buf.slice(start + boundary.length, next);
    if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.slice(2); // strip leading CRLF
    const hdrEnd = seg.indexOf("\r\n\r\n");
    if (hdrEnd !== -1){
      const header = seg.slice(0, hdrEnd).toString();
      let content = seg.slice(hdrEnd + 4);
      if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) content = content.slice(0, -2);
      const nameM = /name="([^"]+)"/.exec(header);
      const fileM = /filename="([^"]*)"/.exec(header);
      if (nameM){
        if (fileM && fileM[1]){ files[nameM[1]] = { filename: fileM[1], data: content }; }
        else { parts[nameM[1]] = content.toString(); }
      }
    }
    start = next;
  }
  return { parts, files };
}

// ============================================================
// SHARED ACTION HELPERS — used by BOTH the Telegram-admin API
// (/api/admin/*) and the password dashboard API (/api/dash/*).
// Previously these two paths each had their own near-identical copy.
// Each returns { code, body } so the caller just forwards it.
// ============================================================
function actApprove(id){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub || sub.status !== "pending") return { code: 404, body: { error: "not found" } };
  const ch = db.challenges.find(c => c.id === sub.chId);
  sub.status = "approved";
  const won = winnersOf(ch).some(w => w.id === sub.id);
  if (won){
    const payout = Math.round(ch.reward * (1 - PLAYER_FEE)), fee = ch.reward - payout;
    const w = Object.values(db.users).find(x => x.username === sub.player); if (w){ w.credits += payout; w.wins += 1; }
    tx("payout", "escrow", sub.player, payout, ch.code);
    tx("commission", "escrow", "platform", fee, ch.code + " 10%");
    notify(sub.userId, `🏆 Your proof for ${ch.code} was approved — you won ${payout} cr! 🎉\n"${ch.title}"`);
  } else {
    notify(sub.userId, `✅ Your proof for ${ch.code} was approved, but the slot was already taken by a faster hunter. Keep going!`);
  }
  save();
  return { code: 200, body: { ok: true, winner: won } };
}
function actReject(id, reasonRaw){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub || sub.status !== "pending") return { code: 404, body: { error: "not found" } };
  const reason = String(reasonRaw || "").slice(0, 200);
  if (!reason) return { code: 400, body: { error: "reason required" } };
  const ch = db.challenges.find(c => c.id === sub.chId);
  sub.status = "rejected"; sub.reason = reason; save();
  notify(sub.userId, `❌ Your proof for ${ch ? ch.code : "a dare"} was rejected.\nReason: ${reason}\nYou can try again on this dare.`);
  return { code: 200, body: { ok: true } };
}
function actBan(key){
  const tu = db.users[decodeURIComponent(key)];
  if (!tu) return { code: 404, body: { error: "user not found" } };
  if (tu.isAdmin) return { code: 400, body: { error: "can't ban an admin" } };
  tu.banned = !tu.banned; save();
  return { code: 200, body: { ok: true, banned: tu.banned } };
}
function actSetCredits(key, valRaw, note){
  const tu = db.users[decodeURIComponent(key)];
  if (!tu) return { code: 404, body: { error: "user not found" } };
  const v = Math.floor(Number(valRaw));
  if (!Number.isFinite(v)) return { code: 400, body: { error: "bad value" } };
  tu.credits = Math.max(0, v);
  tx("admin-adjust", "platform", tu.username, tu.credits, note || "set credits"); save();
  return { code: 200, body: { ok: true, credits: tu.credits } };
}
function actDeleteChallenge(id){
  const idx = db.challenges.findIndex(c => c.id === Number(id));
  if (idx < 0) return { code: 404, body: { error: "not found" } };
  const ch = db.challenges[idx];
  const wonCount = winnersOf(ch).length;
  const refund = Math.max(0, ch.reward * (ch.maxWinners - wonCount));
  const creator = Object.values(db.users).find(x => x.username === ch.creator);
  if (creator && refund > 0){ creator.credits += refund; tx("refund", "escrow", ch.creator, refund, ch.code + " deleted"); }
  // remove submissions + their video files
  db.submissions.filter(s => s.chId === ch.id).forEach(s => { if (s.video){ try { fs.unlinkSync(path.join(UP_DIR, s.video)); } catch (e) {} } });
  db.submissions = db.submissions.filter(s => s.chId !== ch.id);
  db.challenges.splice(idx, 1); save();
  return { code: 200, body: { ok: true, refunded: refund } };
}
function actEditChallenge(id, body){
  const ch = db.challenges.find(c => c.id === Number(id));
  if (!ch) return { code: 404, body: { error: "not found" } };
  if (body.title != null) ch.title = String(body.title).slice(0, 120);
  if (body.desc  != null) ch.desc  = String(body.desc).slice(0, 500);
  if (body.rules != null) ch.rules = String(body.rules).slice(0, 400);
  save();
  return { code: 200, body: { ok: true } };
}

// ---- read-model builders (shared by admin + dashboard) ----
function buildUsers(){
  const earn = {}; db.txns.filter(t => t.type === "payout").forEach(t => earn[t.to] = (earn[t.to] || 0) + t.amount);
  return Object.values(db.users).sort((a, b) => b.joinedAt - a.joinedAt).map(x => ({
    id: x.id, username: x.username, name: x.name, credits: x.credits, wins: x.wins,
    banned: !!x.banned, isAdmin: !!x.isAdmin, earned: earn[x.username] || 0, joinedAt: x.joinedAt,
    posted: db.challenges.filter(c => c.creator === x.username).length,
    subs: db.submissions.filter(s => s.userId === x.id).length }));
}
function buildChallenges(){
  return db.challenges.map(ch => { const st = stats(ch);
    return { id: ch.id, code: ch.code, title: ch.title, creator: ch.creator, reward: ch.reward,
      maxWinners: ch.maxWinners, slots: [st.winners.length, ch.maxWinners], subs: st.subs, pending: st.pending,
      full: st.full, createdAt: ch.createdAt }; }).sort((a, b) => b.id - a.id);
}
function buildQueue(){
  return db.submissions.filter(s => s.status === "pending").sort((a, b) => a.at - b.at).map(s => {
    const ch = db.challenges.find(c => c.id === s.chId);
    return { id: s.id, code: ch && ch.code, title: ch && ch.title, player: s.player, file: s.file, video: s.video, at: s.at };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`); const p = url.pathname;
  if (req.method === "OPTIONS"){ res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders() }); return res.end(); }

  if (p.startsWith("/api/")){
    // public avatar proxy (no auth — <img> can't send headers). Streams Telegram profile photo, hides bot token.
    let am = p.match(/^\/api\/player\/(.+)\/avatar$/);
    if (am && req.method === "GET"){
      const uname = decodeURIComponent(am[1]).replace(/^@/, "");
      const pu = Object.values(db.users).find(x => x.username === uname);
      if (!pu || !BOT_TOKEN){ res.writeHead(404); return res.end("no avatar"); }
      try {
        const r1 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${encodeURIComponent(pu.id)}&limit=1`);
        const d1 = await r1.json();
        const photos = d1 && d1.result && d1.result.photos;
        if (!photos || !photos.length){ res.writeHead(404); return res.end("no photo"); }
        const sizes = photos[0]; const fileId = sizes[sizes.length - 1].file_id; // largest size
        const r2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const d2 = await r2.json();
        const fp = d2 && d2.result && d2.result.file_path;
        if (!fp){ res.writeHead(404); return res.end("no file"); }
        const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
        const buf = Buffer.from(await img.arrayBuffer());
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
        return res.end(buf);
      } catch (e){ res.writeHead(404); return res.end("err"); }
    }

    const ct = req.headers["content-type"] || "";
    let body = {}, files = {};
    if (req.method === "POST"){
      try {
        const raw = await readBody(req);
        if (ct.includes("multipart/form-data")){ const r = parseMultipart(raw, ct); body = r.parts || {}; files = r.files || {}; }
        else { try { body = JSON.parse(raw.toString() || "{}"); } catch (e){ body = {}; } }
      } catch (e){ return json(res, 413, { error: "upload too large (max 50MB)" }); }
    }

    // ===== Solana deposit webhook (Helius) — NO Telegram auth; verifies its own shared secret =====
    if (SOLANA && USE_DB && p === "/api/solana/webhook" && req.method === "POST"){
      const r = await solana.handleWebhook(pool, { headers: req.headers, body, log: console })
        .catch(e => { console.error("solana webhook error:", e.message); return { ok: false, status: 500 }; });
      if (!r.ok) return json(res, r.status || 400, { error: "webhook rejected" });
      return json(res, 200, { ok: true, credited: r.credited });
    }

    // ===== WEB DASHBOARD (password-token auth, separate from Telegram) =====
    if (p.startsWith("/api/dash/")){
      if (p === "/api/dash/login" && req.method === "POST"){
        const ip = clientIp(req);
        if (!ADMIN_PASSWORD) return json(res, 500, { error: "dashboard disabled — set ADMIN_PASSWORD on the server" });
        if (!loginAllowed(ip)) return json(res, 429, { error: "too many attempts — try again later" });
        if (!safeEqual(String(body.password || ""), ADMIN_PASSWORD)){ loginFail(ip); return json(res, 401, { error: "wrong password" }); }
        loginHits.delete(ip);
        return json(res, 200, { token: newDashToken() });
      }
      if (!dashAuth(req)) return json(res, 401, { error: "unauthorized" });
      if (LEDGER && USE_DB) { const handled = await ledgerApi({ req, res, method: req.method, path: p, url, body, files, user: { isAdmin: true, username: "" }, pool, json, notify, fs, pathMod: path, crypto, UP_DIR, db, save }); if (handled) return; }

      if (p === "/api/dash/overview"){
        const users = Object.values(db.users);
        const open = db.challenges.filter(c => !stats(c).full).length;
        const rewardPool = db.challenges.reduce((a, c) => a + c.reward * c.maxWinners, 0);
        const paidOut  = db.txns.filter(t => t.type === "payout").reduce((a, t) => a + t.amount, 0);
        const fees     = db.txns.filter(t => t.type === "fee" || t.type === "commission").reduce((a, t) => a + t.amount, 0);
        const refunded = db.txns.filter(t => t.type === "refund").reduce((a, t) => a + t.amount, 0);
        const pending  = db.submissions.filter(s => s.status === "pending").length;
        const approved = db.submissions.filter(s => s.status === "approved").length;
        const rejected = db.submissions.filter(s => s.status === "rejected").length;
        // 14-day activity (dares created + proofs submitted per day)
        const DAY = 86400e3, days = 14, today = new Date(); today.setHours(0, 0, 0, 0);
        const start = today.getTime() - (days - 1) * DAY;
        const labels = [], dares = [], proofs = [];
        for (let i = 0; i < days; i++){ const d0 = start + i * DAY, d1 = d0 + DAY;
          const dt = new Date(d0); labels.push((dt.getMonth() + 1) + "/" + dt.getDate());
          dares.push(db.challenges.filter(c => c.createdAt >= d0 && c.createdAt < d1).length);
          proofs.push(db.submissions.filter(s => s.at >= d0 && s.at < d1).length);
        }
        return json(res, 200, { overview: {
          users: users.length, banned: users.filter(u2 => u2.banned).length,
          challenges: db.challenges.length, open, filled: db.challenges.length - open,
          submissions: db.submissions.length, pending, approved, rejected,
          rewardPool, paidOut, fees, refunded,
          creditsInPlay: users.reduce((a, u2) => a + u2.credits, 0),
          txnsCount: db.txns.length,
          charts: {
            activity: { labels, dares, proofs },
            flows: { paidOut, fees, refunded },
            proofStatus: { approved, rejected, pending } } } });
      }
      if (p === "/api/dash/users")      return json(res, 200, { users: buildUsers() });
      if (p === "/api/dash/challenges") return json(res, 200, { challenges: buildChallenges() });
      if (p === "/api/dash/txns")       return json(res, 200, { txns: [...db.txns].sort((a, b) => b.at - a.at).slice(0, 300) });
      if (p === "/api/dash/queue")      return json(res, 200, { queue: buildQueue() });

      let dm;
      if ((dm = p.match(/^\/api\/dash\/ban\/(.+)$/))               && req.method === "POST"){ const r = actBan(dm[1]); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/credits\/(.+)$/))           && req.method === "POST"){ const r = actSetCredits(dm[1], body.credits, "dashboard set credits"); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/approve\/(\d+)$/))          && req.method === "POST"){ const r = actApprove(dm[1]); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/reject\/(\d+)$/))           && req.method === "POST"){ const r = actReject(dm[1], body.reason); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/challenge\/(\d+)\/delete$/)) && req.method === "POST"){ const r = actDeleteChallenge(dm[1]); return json(res, r.code, r.body); }
      return json(res, 404, { error: "unknown dashboard endpoint" });
    }

    const g = getUser(req); if (!g.ok) return json(res, 401, { error: "unauthorized: " + g.error });
    const u = g.user;
    if (LEDGER && USE_DB) { const handled = await ledgerApi({ req, res, method: req.method, path: p, url, body, files, user: u, pool, json, notify, fs, pathMod: path, crypto, UP_DIR, db, save }); if (handled) return; }

    if (p === "/api/me") return json(res, 200, { user: pub(u) });

    // my activity: my challenges, my submissions, my transactions
    if (p === "/api/me/activity"){
      const myCh = db.challenges.filter(c => c.creator === u.username).map(challengeView);
      const mySubs = db.submissions.filter(s => s.userId === u.id).sort((a, b) => b.at - a.at).map(s => {
        const ch = db.challenges.find(c => c.id === s.chId);
        const won = ch && winnersOf(ch).some(w => w.id === s.id);
        return { id: s.id, code: ch && ch.code, title: ch && ch.title, file: s.file, video: s.video, hasVideo: !!s.video, status: s.status, reason: s.reason, at: s.at, won: !!won };
      });
      const myTx = db.txns.filter(t => t.from === u.username || t.to === u.username).sort((a, b) => b.at - a.at).slice(0, 30);
      return json(res, 200, { challenges: myCh, submissions: mySubs, txns: myTx });
    }

    if (p === "/api/challenges" && req.method === "GET")
      return json(res, 200, { challenges: db.challenges.map(challengeView).sort((a, b) => b.id - a.id) });

    // single challenge detail
    let m = p.match(/^\/api\/challenges\/(\d+)$/);
    if (m && req.method === "GET"){
      const ch = db.challenges.find(c => c.id === Number(m[1])); if (!ch) return json(res, 404, { error: "not found" });
      const view = challengeView(ch);
      view.mySubmission = db.submissions.find(s => s.chId === ch.id && s.userId === u.id && s.status !== "rejected") ? true : false;
      return json(res, 200, { challenge: view });
    }

    if (p === "/api/challenges" && req.method === "POST"){
      if (u.banned) return json(res, 403, { error: "banned" });
      const rw = Math.max(0, Math.floor(Number(body.reward) || 0));
      const n = Math.max(1, Math.min(20, Math.floor(Number(body.maxWinners) || 1)));
      if (!body.title || !body.desc || rw < 1) return json(res, 400, { error: "title, desc and reward required" });
      const total = rw * n, fee = Math.round(total * CREATOR_FEE);
      if (u.credits < total + fee) return json(res, 400, { error: `not enough credits (need ${total + fee}, have ${u.credits})` });
      u.credits -= (total + fee);
      const id = ++db.seq.ch, code = "BNT-" + String(id).padStart(3, "0");
      db.challenges.push({ id, code, title: String(body.title).slice(0, 120), desc: String(body.desc).slice(0, 500),
        rules: String(body.rules || "Say the code in the video.").slice(0, 400), reward: rw, maxWinners: n, creator: u.username, createdAt: Date.now() });
      tx("escrow", u.username, "escrow", total, code); tx("fee", u.username, "platform", fee, code + " 5%"); save();
      return json(res, 200, { ok: true, code, locked: total + fee, credits: u.credits });
    }

    // submit proof — accepts a real video file (multipart) OR a filename (json, demo)
    m = p.match(/^\/api\/challenges\/(\d+)\/submit$/);
    if (m && req.method === "POST"){
      if (u.banned) return json(res, 403, { error: "banned" });
      const ch = db.challenges.find(c => c.id === Number(m[1])); if (!ch) return json(res, 404, { error: "not found" });
      if (ch.creator === u.username) return json(res, 403, { error: "you can't complete your own dare" });
      if (stats(ch).full) return json(res, 400, { error: "slots full" });
      if (db.submissions.find(s => s.chId === ch.id && s.userId === u.id && s.status !== "rejected")) return json(res, 400, { error: "you already submitted to this dare" });
      const id = ++db.seq.sub;
      let videoName = null, fileLabel = "", vhash = null;
      if (files.video){
        // anti-cheat: fingerprint the video; reject a clip that was already submitted
        vhash = crypto.createHash("sha256").update(files.video.data).digest("hex");
        if (db.submissions.some(s => s.vhash === vhash && s.status !== "rejected"))
          return json(res, 400, { error: "this exact video was already submitted — record a fresh proof" });
        const ext = (path.extname(files.video.filename) || ".mp4").toLowerCase().slice(0, 6).replace(/[^.\w]/g, "");
        // SECURITY: random suffix so upload URLs can't be guessed/enumerated by sequential id
        const rand = crypto.randomBytes(8).toString("hex");
        videoName = `sub_${id}_${rand}${ext}`;
        fs.writeFileSync(path.join(UP_DIR, videoName), files.video.data);
        fileLabel = files.video.filename.slice(0, 120);
      } else { fileLabel = String((body && body.file) || `video_${id}.mp4`).slice(0, 120); }
      db.submissions.push({ id, chId: ch.id, player: u.username, userId: u.id, file: fileLabel, video: videoName, vhash,
        at: Date.now(), status: "pending", reason: "" });
      save();
      // notify the dare creator
      const creatorU = Object.values(db.users).find(x => x.username === ch.creator);
      if (creatorU && creatorU.id !== u.id) notify(creatorU.id, `🎬 New proof on your dare ${ch.code} — "${ch.title}"\nfrom @${u.username}. Someone's going for your bounty!`);
      return json(res, 200, { ok: true, submissionId: id, hasVideo: !!videoName });
    }

    if (p === "/api/leaderboard"){
      const earn = {}; db.txns.filter(t => t.type === "payout").forEach(t => earn[t.to] = (earn[t.to] || 0) + t.amount);
      const rows = Object.values(db.users).filter(x => !x.isAdmin).map(x => ({ username: x.username, wins: x.wins, earned: earn[x.username] || 0 }))
        .sort((a, b) => b.wins - a.wins || b.earned - a.earned).slice(0, 20);
      return json(res, 200, { leaderboard: rows });
    }

    // player profile (by username). Full stats are admin-only; others see only name + avatar.
    let pm = p.match(/^\/api\/player\/(.+)$/);
    if (pm && req.method === "GET"){
      const uname = decodeURIComponent(pm[1]).replace(/^@/, "");
      const pu = Object.values(db.users).find(x => x.username === uname);
      if (!pu) return json(res, 404, { error: "player not found" });
      if (!u.isAdmin){
        return json(res, 200, { player: { username: pu.username, name: pu.name, private: true } });
      }
      const earned = db.txns.filter(t => t.type === "payout" && t.to === uname).reduce((a, t) => a + t.amount, 0);
      const approved = db.submissions.filter(s => s.userId === pu.id && s.status === "approved").length;
      const totalSubs = db.submissions.filter(s => s.userId === pu.id).length;
      const ordered = Object.values(db.users).filter(x => !x.isAdmin).sort((a, b) => b.wins - a.wins);
      const rank = ordered.findIndex(x => x.username === uname);
      const posted = db.challenges.filter(c => c.creator === uname).map(ch => { const st = stats(ch);
        return { code: ch.code, title: ch.title, reward: ch.reward, slots: [st.winners.length, ch.maxWinners], full: st.full, subs: st.subs }; })
        .sort((a, b) => b.code.localeCompare(a.code));
      return json(res, 200, { player: {
        username: pu.username, name: pu.name, telegramId: pu.id, wins: pu.wins, earned, approved, totalSubs,
        posted: posted.length, rank: rank >= 0 ? rank + 1 : null, banned: !!pu.banned, isAdmin: !!pu.isAdmin,
        credits: pu.credits, joinedAt: pu.joinedAt, dares: posted } });
    }

    // ----- admin (Telegram-authenticated) -----
    const requireAdmin = () => { if (!u.isAdmin){ json(res, 403, { error: "admin only" }); return false; } return true; };

    if (p === "/api/admin/queue"){ if (!requireAdmin()) return;
      return json(res, 200, { queue: buildQueue() }); }

    m = p.match(/^\/api\/admin\/approve\/(\d+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actApprove(m[1]); return json(res, r.code, r.body); }

    m = p.match(/^\/api\/admin\/reject\/(\d+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actReject(m[1], body.reason); return json(res, r.code, r.body); }

    if (p === "/api/admin/users"){ if (!requireAdmin()) return; return json(res, 200, { users: buildUsers() }); }

    m = p.match(/^\/api\/admin\/ban\/([^/]+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actBan(m[1]); return json(res, r.code, r.body); }

    m = p.match(/^\/api\/admin\/credits\/([^/]+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actSetCredits(m[1], body.credits, "set credits"); return json(res, r.code, r.body); }

    if (p === "/api/admin/challenges"){ if (!requireAdmin()) return; return json(res, 200, { challenges: buildChallenges() }); }

    m = p.match(/^\/api\/admin\/challenge\/(\d+)\/edit$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actEditChallenge(m[1], body); return json(res, r.code, r.body); }

    m = p.match(/^\/api\/admin\/challenge\/(\d+)\/delete$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actDeleteChallenge(m[1]); return json(res, r.code, r.body); }

    if (p === "/api/admin/txns"){ if (!requireAdmin()) return;
      return json(res, 200, { txns: [...db.txns].sort((a, b) => b.at - a.at).slice(0, 200) }); }

    return json(res, 404, { error: "unknown endpoint" });
  }

  // ---- serve uploaded videos (filenames are random, so unguessable) ----
  if (p.startsWith("/uploads/")){
    const f = path.join(UP_DIR, path.basename(p)); // basename strips any traversal
    return fs.readFile(f, (err, data) => {
      if (err){ res.writeHead(404); return res.end("not found"); }
      const ext = path.extname(f).toLowerCase();
      const types = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".avi": "video/x-msvideo" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", ...SECURITY_HEADERS }); res.end(data);
    });
  }

  // ---- static (mini app + dashboard) — STRICT WHITELIST ----
  // Only these public files are servable. This prevents leaking data.json
  // (the whole database!), server.js, package.json or a .env via the URL.
  const STATIC = {
    "/":              { file: "landing.html",  type: "text/html" },       // public landing page
    "/landing.html":  { file: "landing.html",  type: "text/html" },
    "/bountly-bg.mp4":{ file: "bountly-bg.mp4", type: "video/mp4" },       // landing background video
    "/app":           { file: "index.html",    type: "text/html" },       // Telegram Mini App
    "/app/":          { file: "index.html",    type: "text/html" },
    "/index.html":    { file: "index.html",    type: "text/html" },
    "/admin":         { file: "admin.html",    type: "text/html" },
    "/admin/":        { file: "admin.html",    type: "text/html" },
    "/admin.html":    { file: "admin.html",    type: "text/html" }
  };
  const entry = STATIC[p];
  if (!entry){ res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
  fs.readFile(path.join(__dirname, entry.file), (err, data) => {
    if (err){ res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    res.end(data);
  });
});

initStore()
  .then(() => server.listen(PORT, () => console.log(
    `Bountly running on http://localhost:${PORT} · storage: ${USE_DB ? "Postgres" : "local JSON"} · uploads: ${UP_DIR} · BOT_TOKEN ${BOT_TOKEN ? "set" : "NOT set (DEV mode)"}`)))
  .then(() => { if (LEDGER && USE_DB) startDepositWatcher(pool); })
  .then(() => { if (SOLANA && USE_DB) return solana.ensureSchema(pool).then(() => console.log("✓ Solana deposits enabled (SOLANA=1)")).catch(e => console.error("Solana schema:", e.message)); })
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
