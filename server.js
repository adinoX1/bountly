// ============================================================
// BOUNTLY — Telegram Mini App backend. Run: node server.js (Node 18+)
//
// This file is the HTTP layer: routing, Telegram auth, static serving, and the
// legacy JSON-blob store used when DATABASE_URL is unset. With LEDGER=1 the
// money and dare routes are delegated to server_ledger.js instead, which is
// backed by the double-entry ledger in ledger.js / wallet.js.
//
// Design notes worth knowing before editing:
//  • the static server is a strict WHITELIST — anything not listed is a 404,
//    which is what keeps the JSON store, .env and this file unreachable
//  • without a BOT_TOKEN the server runs in DEV mode with auth bypassed; that
//    is refused outright when NODE_ENV=production
//  • framing is controlled per-page by CSP frame-ancestors, NOT by
//    X-Frame-Options — Telegram Web has to be able to iframe the mini app
//  • see README.md for the operational limits (ephemeral uploads, one instance)
// ============================================================
import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ledgerApi } from "./server_ledger.js";
import { initLedger, withClient, startExpiryWatcher } from "./wallet.js";
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
// Balances are dollar-pegged stablecoins (USDT on TON, USDC on Solana), so
// every number a player reads is money, not "credits".
const money = n => { const v = Number(n); if (!isFinite(v)) return "$0";
  const a = Math.abs(v), s = "$" + (Number.isInteger(a) ? a : a.toFixed(2));
  return v < 0 ? "-" + s : s; };
const MAX_VIDEO      = 50 * 1024 * 1024;            // 50 MB cap
const APP_LINK       = process.env.APP_LINK || "";  // e.g. https://t.me/getbountlybot/arena
const PUBLIC_URL     = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // for the Telegram webhook
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

// ---- rate limiting (per IP, fixed window) ----
// One shared bucket implementation. Each named limiter keeps its own Map so
// a burst of uploads can't lock someone out of the login form and vice versa.
function clientIp(req){
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "unknown";
}
function rateLimiter(windowMs, max){
  const hits = new Map(); // key -> { count, first }
  return {
    hits,
    // count this request and report whether it is still inside the budget
    take(key){
      const now = Date.now(); let rec = hits.get(key);
      if (!rec || now - rec.first > windowMs){ rec = { count: 0, first: now }; hits.set(key, rec); }
      rec.count++;
      return rec.count <= max;
    },
    // check without consuming (login counts only FAILED attempts)
    allowed(key){
      const now = Date.now(), rec = hits.get(key);
      return !rec || now - rec.first > windowMs || rec.count < max;
    },
    fail(key){
      const now = Date.now(); let rec = hits.get(key);
      if (!rec || now - rec.first > windowMs){ rec = { count: 0, first: now }; hits.set(key, rec); }
      rec.count++;
    },
    reset(key){ hits.delete(key); },
    sweep(now){ for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k); }
  };
}
const loginLimit  = rateLimiter(15 * 60e3, 8);    // dashboard password attempts
const writeLimit  = rateLimiter(60e3, 30);        // any authenticated POST
const uploadLimit = rateLimiter(60 * 60e3, 20);   // proof submissions per hour
const avatarLimit = rateLimiter(60e3, 60);        // unauthenticated avatar proxy

// Cached Telegram profile photos: username -> { buf, exp }. Without this every
// <img> hit fanned out into three calls to the Telegram API, which is a fast
// way to get the bot rate-limited by someone hammering a public endpoint.
const AVATAR_TTL = 6 * 3600e3;
const avatarCache = new Map();

// The Maps above and dashTokens only ever grew. Sweep expired entries so a
// long-running instance doesn't leak memory on every IP that ever connected.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const l of [loginLimit, writeLimit, uploadLimit, avatarLimit]) l.sweep(now);
  for (const [t, exp] of dashTokens) if (now > exp) dashTokens.delete(t);
  for (const [k, v] of avatarCache) if (now > v.exp) avatarCache.delete(k);
}, 10 * 60e3);
sweeper.unref?.();
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

// ---- Telegram bot commands (webhook-driven) ----
const TG_SECRET = BOT_TOKEN ? crypto.createHash("sha256").update("bountly-wh:" + BOT_TOKEN).digest("hex").slice(0, 40) : "";
// null when neither is configured — Telegram rejects a button with a relative URL
const TG_OPEN_URL = APP_LINK || (PUBLIC_URL ? PUBLIC_URL + "/app" : "");
const TG_OPEN_BTN = TG_OPEN_URL ? { inline_keyboard: [[{ text: "⚡ Open Bountly", url: TG_OPEN_URL }]] } : null;
const TG_WELCOME = "Welcome to Bountly ⚡\n\nFilm the dare. Prove it. Win the bounty.\nPost a challenge, set a bounty — first valid proof takes the cash.\n\nTap below to enter the arena.";
const TG_HOW = "How Bountly works\n\n1. Post a dare & set a bounty 💰\n2. Hunters film their proof and submit it 🎬\n3. First valid proof wins the bounty 🏆\n\nChallenge yourself — tap below to start.";
async function tgReply(chatId, text){
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true,
        ...(TG_OPEN_BTN ? { reply_markup: TG_OPEN_BTN } : {}) })
    });
  } catch (e){ console.error("tgReply:", e.message); }
}
async function registerTelegram(){
  if (!BOT_TOKEN) return;
  // This used to fall back to a hardcoded personal domain, so anyone deploying
  // a fork with a bot token silently pointed their webhook at someone else's
  // host. Refuse to guess: no PUBLIC_URL, no webhook.
  if (!PUBLIC_URL){
    console.warn("⚠️  PUBLIC_URL not set — skipping Telegram webhook registration. Bot commands (/start) will not work.");
    return;
  }
  const base = `https://api.telegram.org/bot${BOT_TOKEN}`;
  try {
    await fetch(`${base}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: PUBLIC_URL + "/api/tg/webhook", secret_token: TG_SECRET, allowed_updates: ["message"] }) });
    await fetch(`${base}/setMyCommands`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: [
        { command: "start",       description: "Start & open Bountly" },
        { command: "howitworks",  description: "How Bountly works" } ] }) });
    console.log("✓ Telegram commands + webhook registered");
  } catch (e){ console.error("registerTelegram:", e.message); }
}

// DATA_FILE mirrors UPLOAD_DIR: it keeps the JSON store out of the source tree
// (and lets tests run against a throwaway file instead of the repo's own).
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
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
// NOTE: no X-Frame-Options here. It used to say SAMEORIGIN, which blocks the
// mini app inside Telegram Web — Telegram embeds it in an iframe from
// web.telegram.org. Framing is controlled per-page by CSP frame-ancestors
// below: the mini app allows Telegram, the admin dashboard allows nobody.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};
const TELEGRAM_FRAME = "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org";
// The pages lean on inline <script>/<style> and pull the QR lib from cdnjs,
// so 'unsafe-inline' has to stay for now; everything else is locked down.
const CSP_APP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  TELEGRAM_FRAME
].join("; ");
const CSP_ADMIN = CSP_APP.replace(TELEGRAM_FRAME, "frame-ancestors 'none'");
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
    subs: st.subs, pending: st.pending, expiresAt: ch.expiresAt || null, expired: !!ch.expired,
    winners: st.winners.map(w => ({ player: w.player, at: w.at })) };
}

// ---- dare expiry (JSON mode; the LEDGER path has its own sweeper in wallet.js) ----
// Without a deadline the creator's escrow stays locked forever when nobody
// completes the dare — the only way out was an admin deleting it by hand.
const DARE_TTL_DAYS = Number(process.env.DARE_TTL_DAYS ?? 14);
function expireChallenges(){
  const now = Date.now(); const done = [];
  for (const ch of db.challenges){
    if (ch.expired || !ch.expiresAt || ch.expiresAt > now) continue;
    // someone is waiting on us — a proof under review OR an open dispute —
    // so refunding the creator out from under them now would be unfair
    if (stats(ch).pending > 0 || db.submissions.some(s => s.chId === ch.id && s.status === "disputed")) continue;
    const refund = Math.max(0, ch.reward * (ch.maxWinners - winnersOf(ch).length));
    const creator = Object.values(db.users).find(x => x.username === ch.creator);
    if (creator && refund > 0){ creator.credits += refund; tx("refund", "escrow", ch.creator, refund, ch.code + " expired"); }
    ch.expired = true;
    done.push({ code: ch.code, creator: ch.creator, refunded: refund, creatorId: creator && creator.id });
  }
  if (done.length){
    save();
    for (const d of done){
      console.log(`dare ${d.code} expired — refunded ${d.refunded} to @${d.creator}`);
      if (d.creatorId) notify(d.creatorId, `⏳ Your dare ${d.code} expired — nobody claimed it.\n${money(d.refunded)} has been refunded to your balance.`);
    }
  }
  return done;
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
// How long after a rejection a hunter may appeal (mirrors ledger APPEAL_WINDOW_MS).
const APPEAL_WINDOW_MS = Number(process.env.APPEAL_WINDOW_HOURS ?? 48) * 3600e3;

// Mark a submission approved and pay it IF it is among the fastest valid proofs.
// Shared by a normal approval and by overturning a dispute, so both settle money
// the same way. Returns whether this proof actually won a slot.
function approveAndPay(sub){
  const ch = db.challenges.find(c => c.id === sub.chId);
  sub.status = "approved"; sub.decidedAt = Date.now();
  const won = winnersOf(ch).some(w => w.id === sub.id);
  if (won){
    const payout = Math.round(ch.reward * (1 - PLAYER_FEE)), fee = ch.reward - payout;
    const w = Object.values(db.users).find(x => x.username === sub.player); if (w){ w.credits += payout; w.wins += 1; }
    tx("payout", "escrow", sub.player, payout, ch.code);
    tx("commission", "escrow", "platform", fee, ch.code + " 10%");
  }
  return { ch, won };
}
function actApprove(id){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub || sub.status !== "pending") return { code: 404, body: { error: "not found" } };
  const { ch, won } = approveAndPay(sub);
  notify(sub.userId, won
    ? `🏆 Your proof for ${ch.code} was approved — you won ${money(Math.round(ch.reward * (1 - PLAYER_FEE)))}! 🎉\n"${ch.title}"`
    : `✅ Your proof for ${ch.code} was approved, but the slot was already taken by a faster hunter. Keep going!`);
  save();
  return { code: 200, body: { ok: true, winner: won } };
}
function actReject(id, reasonRaw){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub || sub.status !== "pending") return { code: 404, body: { error: "not found" } };
  const reason = String(reasonRaw || "").slice(0, 200);
  if (!reason) return { code: 400, body: { error: "reason required" } };
  const ch = db.challenges.find(c => c.id === sub.chId);
  sub.status = "rejected"; sub.reason = reason; sub.decidedAt = Date.now(); save();
  notify(sub.userId, `❌ Your proof for ${ch ? ch.code : "a dare"} was rejected.\nReason: ${reason}\nYou can record a fresh proof, or appeal this once from your profile.`);
  return { code: 200, body: { ok: true } };
}
// ---- dispute / appeal (JSON mode; mirrors ledger.js appeal/resolveDispute) ----
function subCanAppeal(sub){
  if (!sub || sub.status !== "rejected" || sub.appealed) return false;
  if (sub.decidedAt && Date.now() - sub.decidedAt > APPEAL_WINDOW_MS) return false;
  const ch = db.challenges.find(c => c.id === sub.chId);
  if (!ch || ch.expired || stats(ch).full) return false;
  return true;
}
function actAppeal(id, requester){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub) return { code: 404, body: { error: "not found" } };
  if (sub.player !== requester.username) return { code: 403, body: { error: "not your proof" } };
  if (sub.status !== "rejected") return { code: 400, body: { error: "only a rejected proof can be appealed" } };
  if (sub.appealed) return { code: 400, body: { error: "you have already appealed this proof once" } };
  if (sub.decidedAt && Date.now() - sub.decidedAt > APPEAL_WINDOW_MS) return { code: 400, body: { error: "the appeal window has closed" } };
  const ch = db.challenges.find(c => c.id === sub.chId);
  if (!ch || ch.expired) return { code: 400, body: { error: "this dare is already closed" } };
  if (stats(ch).full) return { code: 400, body: { error: "all winner slots are already filled" } };
  if (db.submissions.some(s => s.chId === ch.id && s.player === sub.player && s.id !== sub.id &&
      (s.status === "pending" || s.status === "disputed" || s.status === "approved")))
    return { code: 400, body: { error: "you already have another live proof on this dare" } };
  sub.status = "disputed"; sub.appealed = true; sub.appealedAt = Date.now(); save();
  // let the review team know a decision is being contested
  Object.values(db.users).filter(u => u.isAdmin).forEach(a =>
    notify(a.id, `⚖️ @${sub.player} appealed a rejected proof on ${ch.code} — "${ch.title}". It needs a second look.`));
  return { code: 200, body: { ok: true } };
}
function actResolveDispute(id, uphold, reasonRaw){
  const sub = db.submissions.find(s => s.id === Number(id));
  if (!sub || sub.status !== "disputed") return { code: 404, body: { error: "not found" } };
  const ch = db.challenges.find(c => c.id === sub.chId);
  if (uphold){
    sub.status = "rejected"; sub.decidedAt = Date.now();
    if (reasonRaw) sub.reason = String(reasonRaw).slice(0, 200);
    save();
    notify(sub.userId, `⚖️ Your appeal on ${ch ? ch.code : "a dare"} was reviewed — the rejection stands. This decision is final.`);
    return { code: 200, body: { ok: true, upheld: true } };
  }
  const { won } = approveAndPay(sub); save();
  notify(sub.userId, won
    ? `🏆 Your appeal on ${ch.code} was upheld — approved and the bounty paid out! 🎉`
    : `✅ Your appeal on ${ch.code} was upheld and approved, but the slot was already taken by a faster hunter.`);
  return { code: 200, body: { ok: true, upheld: false, winner: won } };
}
function buildDisputes(){
  return db.submissions.filter(s => s.status === "disputed")
    .sort((a, b) => (a.appealedAt || a.at) - (b.appealedAt || b.at)).map(s => {
      const ch = db.challenges.find(c => c.id === s.chId);
      return { id: s.id, code: ch && ch.code, title: ch && ch.title, player: s.player,
        file: s.file, video: s.video, reason: s.reason || "", at: s.at, appealedAt: s.appealedAt || null };
    });
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
  // Behind Railway/any TLS-terminating proxy the socket is plain HTTP, so trust
  // the forwarded scheme to decide whether HSTS applies. setHeader survives the
  // later writeHead(code, headers) calls, so every response picks it up.
  if ((req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https")
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");

  if (req.method === "OPTIONS"){ res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders() }); return res.end(); }

  if (p.startsWith("/api/")){
    // public avatar proxy (no auth — <img> can't send headers). Streams Telegram profile photo, hides bot token.
    let am = p.match(/^\/api\/player\/(.+)\/avatar$/);
    if (am && req.method === "GET"){
      const uname = decodeURIComponent(am[1]).replace(/^@/, "");
      // Unauthenticated by necessity — an <img> can't send auth headers — so it
      // needs its own budget and a cache, otherwise each hit costs three calls
      // to the Telegram API and anyone can burn the bot's rate limit for us.
      if (!avatarLimit.take(clientIp(req))){ res.writeHead(429, SECURITY_HEADERS); return res.end("slow down"); }
      const hit = avatarCache.get(uname);
      if (hit && Date.now() < hit.exp){
        if (!hit.buf){ res.writeHead(404, SECURITY_HEADERS); return res.end("no avatar"); }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", ...SECURITY_HEADERS });
        return res.end(hit.buf);
      }
      const miss = () => { avatarCache.set(uname, { buf: null, exp: Date.now() + AVATAR_TTL }); };
      const pu = Object.values(db.users).find(x => x.username === uname);
      if (!pu || !BOT_TOKEN){ miss(); res.writeHead(404, SECURITY_HEADERS); return res.end("no avatar"); }
      try {
        const r1 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${encodeURIComponent(pu.id)}&limit=1`);
        const d1 = await r1.json();
        const photos = d1 && d1.result && d1.result.photos;
        if (!photos || !photos.length){ miss(); res.writeHead(404, SECURITY_HEADERS); return res.end("no photo"); }
        const sizes = photos[0]; const fileId = sizes[sizes.length - 1].file_id; // largest size
        const r2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const d2 = await r2.json();
        const fp = d2 && d2.result && d2.result.file_path;
        if (!fp){ miss(); res.writeHead(404, SECURITY_HEADERS); return res.end("no file"); }
        const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
        const buf = Buffer.from(await img.arrayBuffer());
        avatarCache.set(uname, { buf, exp: Date.now() + AVATAR_TTL });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", ...SECURITY_HEADERS });
        return res.end(buf);
      } catch (e){ miss(); res.writeHead(404, SECURITY_HEADERS); return res.end("err"); }
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

    // ===== Telegram bot webhook (commands) — verifies Telegram's secret token =====
    if (BOT_TOKEN && p === "/api/tg/webhook" && req.method === "POST"){
      if ((req.headers["x-telegram-bot-api-secret-token"] || "") !== TG_SECRET){ res.writeHead(401); return res.end("no"); }
      const msg = body && (body.message || body.edited_message);
      if (msg && msg.text && msg.chat){
        const t = String(msg.text).trim().toLowerCase();
        if (t === "/start" || t.startsWith("/start@") || t.startsWith("/start ")) tgReply(msg.chat.id, TG_WELCOME);
        else if (t.startsWith("/howitworks")) tgReply(msg.chat.id, TG_HOW);
      }
      res.writeHead(200, SECURITY_HEADERS); return res.end("ok");
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
        if (!loginLimit.allowed(ip)) return json(res, 429, { error: "too many attempts — try again later" });
        if (!safeEqual(String(body.password || ""), ADMIN_PASSWORD)){ loginLimit.fail(ip); return json(res, 401, { error: "wrong password" }); }
        loginLimit.reset(ip);
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
      if (p === "/api/dash/disputes")   return json(res, 200, { disputes: buildDisputes() });

      let dm;
      if ((dm = p.match(/^\/api\/dash\/ban\/(.+)$/))               && req.method === "POST"){ const r = actBan(dm[1]); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/credits\/(.+)$/))           && req.method === "POST"){ const r = actSetCredits(dm[1], body.credits, "dashboard set credits"); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/approve\/(\d+)$/))          && req.method === "POST"){ const r = actApprove(dm[1]); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/reject\/(\d+)$/))           && req.method === "POST"){ const r = actReject(dm[1], body.reason); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/dispute\/(\d+)\/resolve$/)) && req.method === "POST"){ const r = actResolveDispute(dm[1], !!body.uphold, body.reason); return json(res, r.code, r.body); }
      if ((dm = p.match(/^\/api\/dash\/challenge\/(\d+)\/delete$/)) && req.method === "POST"){ const r = actDeleteChallenge(dm[1]); return json(res, r.code, r.body); }
      return json(res, 404, { error: "unknown dashboard endpoint" });
    }

    const g = getUser(req); if (!g.ok) return json(res, 401, { error: "unauthorized: " + g.error });
    const u = g.user;

    // Per-user write budget. Nothing but the dashboard login was limited, so a
    // single account could hammer dare creation or push 50 MB uploads in a loop.
    if (req.method === "POST"){
      // /api/wallet/scan is a read against the chain, not a write, and carries
      // its own per-user throttle — it must not eat a player's write budget
      // while their deposit sheet is open.
      if (p !== "/api/wallet/scan" && !writeLimit.take(u.id))
        return json(res, 429, { error: "too many requests — slow down" });
      if (/\/submit$/.test(p) && !uploadLimit.take(u.id))
        return json(res, 429, { error: "too many proof uploads this hour — try again later" });
    }
    if (LEDGER && USE_DB) { const handled = await ledgerApi({ req, res, method: req.method, path: p, url, body, files, user: u, pool, json, notify, fs, pathMod: path, crypto, UP_DIR, db, save }); if (handled) return; }

    if (p === "/api/me") return json(res, 200, { user: pub(u) });

    // my activity: my challenges, my submissions, my transactions
    if (p === "/api/me/activity"){
      const myCh = db.challenges.filter(c => c.creator === u.username).map(challengeView);
      const mySubs = db.submissions.filter(s => s.userId === u.id).sort((a, b) => b.at - a.at).map(s => {
        const ch = db.challenges.find(c => c.id === s.chId);
        const won = ch && winnersOf(ch).some(w => w.id === s.id);
        return { id: s.id, code: ch && ch.code, title: ch && ch.title, file: s.file, video: s.video, hasVideo: !!s.video,
          status: s.status, reason: s.reason, at: s.at, won: !!won, canAppeal: subCanAppeal(s) };
      });
      const myTx = db.txns.filter(t => t.from === u.username || t.to === u.username).sort((a, b) => b.at - a.at).slice(0, 30);
      return json(res, 200, { challenges: myCh, submissions: mySubs, txns: myTx });
    }

    // appeal a rejected proof (hunter must own it)
    let ap = p.match(/^\/api\/submissions\/(\d+)\/appeal$/);
    if (ap && req.method === "POST"){
      if (u.banned) return json(res, 403, { error: "banned" });
      const r = actAppeal(ap[1], u); return json(res, r.code, r.body);
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
      // Bounties are whole dollars (JSON mode settles payouts in whole units),
      // so a typed 7.50 is refused rather than silently floored to 7.
      const rawRw = Number(body.reward);
      const rw = Math.max(0, Math.floor(rawRw || 0));
      if (Number.isFinite(rawRw) && rawRw !== rw && rw >= 1)
        return json(res, 400, { error: `bounties are whole dollars — use ${money(rw)} or ${money(rw + 1)}` });
      const n = Math.max(1, Math.min(20, Math.floor(Number(body.maxWinners) || 1)));
      if (!body.title || !body.desc || rw < 1) return json(res, 400, { error: "title, desc and reward required" });
      const total = rw * n, fee = Math.round(total * CREATOR_FEE);
      if (u.credits < total + fee) return json(res, 400, { error: `not enough funds (need ${money(total + fee)}, you have ${money(u.credits)})` });
      u.credits -= (total + fee);
      const ttlRaw = body.expiresInDays == null ? (DARE_TTL_DAYS > 0 ? DARE_TTL_DAYS : null) : Number(body.expiresInDays);
      if (ttlRaw != null && !(ttlRaw > 0 && ttlRaw <= 365)) return json(res, 400, { error: "expiresInDays must be between 1 and 365" });
      const id = ++db.seq.ch, code = "BNT-" + String(id).padStart(3, "0");
      db.challenges.push({ id, code, title: String(body.title).slice(0, 120), desc: String(body.desc).slice(0, 500),
        rules: String(body.rules || "Say the code in the video.").slice(0, 400), reward: rw, maxWinners: n, creator: u.username,
        createdAt: Date.now(), expiresAt: ttlRaw == null ? null : Date.now() + ttlRaw * 86400e3 });
      tx("escrow", u.username, "escrow", total, code); tx("fee", u.username, "platform", fee, code + " 5%"); save();
      return json(res, 200, { ok: true, code, locked: total + fee, credits: u.credits });
    }

    // submit proof — accepts a real video file (multipart) OR a filename (json, demo)
    m = p.match(/^\/api\/challenges\/(\d+)\/submit$/);
    if (m && req.method === "POST"){
      if (u.banned) return json(res, 403, { error: "banned" });
      const ch = db.challenges.find(c => c.id === Number(m[1])); if (!ch) return json(res, 404, { error: "not found" });
      if (ch.creator === u.username) return json(res, 403, { error: "you can't complete your own dare" });
      // the sweeper runs on an interval, so check the deadline directly too
      if (ch.expired || (ch.expiresAt && ch.expiresAt <= Date.now())) return json(res, 400, { error: "this dare has expired" });
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

    if (p === "/api/admin/disputes"){ if (!requireAdmin()) return;
      return json(res, 200, { disputes: buildDisputes() }); }

    m = p.match(/^\/api\/admin\/approve\/(\d+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actApprove(m[1]); return json(res, r.code, r.body); }

    m = p.match(/^\/api\/admin\/reject\/(\d+)$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actReject(m[1], body.reason); return json(res, r.code, r.body); }

    m = p.match(/^\/api\/admin\/dispute\/(\d+)\/resolve$/);
    if (m && req.method === "POST"){ if (!requireAdmin()) return; const r = actResolveDispute(m[1], !!body.uphold, body.reason); return json(res, r.code, r.body); }

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
  // Streamed, with byte-range support. Both matter:
  //  • iOS Safari and the Telegram in-app player open a video with
  //    "Range: bytes=0-" and refuse to play a plain 200 response, so
  //    without 206 handling proofs simply don't play on iPhone;
  //  • the old fs.readFile buffered the whole clip (up to 50 MB) into
  //    memory per viewer, so a handful of concurrent plays could OOM
  //    the container.
  if (p.startsWith("/uploads/")){
    const name = path.basename(p.slice("/uploads/".length));
    if (!/^[\w.-]+$/.test(name)){ res.writeHead(404, SECURITY_HEADERS); return res.end("not found"); }
    const f = path.join(UP_DIR, name);
    return fs.stat(f, (err, st) => {
      if (err || !st.isFile()){ res.writeHead(404, SECURITY_HEADERS); return res.end("not found"); }
      const types = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".avi": "video/x-msvideo" };
      const head = {
        "Content-Type": types[path.extname(f).toLowerCase()] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        ...SECURITY_HEADERS
      };
      const send = (code, extra, start, end) => {
        res.writeHead(code, { ...head, ...extra });
        if (req.method === "HEAD") return res.end();
        const s = fs.createReadStream(f, start == null ? undefined : { start, end });
        s.on("error", () => res.destroy());          // don't take the process down
        res.on("close", () => s.destroy());          // viewer seeked away / closed
        s.pipe(res);
      };

      const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (rm && (rm[1] || rm[2])){
        // "bytes=500-999", "bytes=500-" (open-ended) or "bytes=-500" (suffix)
        let start = rm[1] ? Number(rm[1]) : st.size - Number(rm[2]);
        let end   = rm[1] ? (rm[2] ? Number(rm[2]) : st.size - 1) : st.size - 1;
        start = Math.max(0, start); end = Math.min(end, st.size - 1);
        if (start >= st.size || end < start){
          res.writeHead(416, { ...head, "Content-Range": `bytes */${st.size}` });
          return res.end();
        }
        return send(206, { "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 }, start, end);
      }
      return send(200, { "Content-Length": st.size });
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
    const csp = entry.file === "admin.html" ? CSP_ADMIN : CSP_APP;
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache",
      ...(entry.type === "text/html" ? { "Content-Security-Policy": csp } : {}),
      ...SECURITY_HEADERS });
    res.end(data);
  });
});

initStore()
  .then(() => server.listen(PORT, () => console.log(
    `Bountly running on http://localhost:${PORT} · storage: ${USE_DB ? "Postgres" : "local JSON"} · uploads: ${UP_DIR} · BOT_TOKEN ${BOT_TOKEN ? "set" : "NOT set (DEV mode)"}`)))
  .then(() => { if (LEDGER && USE_DB) startDepositWatcher(pool); })
  .then(() => { if (!(LEDGER && USE_DB)){ const t = setInterval(expireChallenges, 5 * 60e3); t.unref?.(); expireChallenges(); } })
  .then(() => { if (LEDGER && USE_DB) startExpiryWatcher(pool, { onExpired: e => {
    const creator = Object.values(db.users).find(x => x.username === e.creator);
    if (creator) notify(creator.id, `⏳ Your dare ${e.code} expired — nobody claimed it.\n${money(e.refundedUsdt)} has been refunded to your balance.`);
  } }); })
  .then(() => { if (SOLANA && USE_DB) return solana.ensureSchema(pool)
    .then(() => { console.log("✓ Solana deposits enabled (SOLANA=1)"); solana.startAddressWatcher(pool); })
    .catch(e => console.error("Solana schema:", e.message)); })
  .then(() => registerTelegram())
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
