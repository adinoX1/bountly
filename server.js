// ============================================================
//  BOUNTLY — Telegram Mini App backend (v2)
//  Adds: real video upload, challenge detail, profile/activity.
//  Uses CREDITS, not real money.  Run:  node server.js  (Node 18+)
// ============================================================
import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_TOKEN  = process.env.BOT_TOKEN  || "";
const ADMIN_IDS  = (process.env.ADMIN_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
const PORT       = process.env.PORT || 3000;
const PLAYER_FEE = 0.10, CREATOR_FEE = 0.05;
const START_CREDITS = 100;
const MAX_VIDEO = 50 * 1024 * 1024;      // 50 MB cap
const APP_LINK = process.env.APP_LINK || "";   // optional, e.g. https://t.me/getbountlybot/arena

// ---- send a Telegram notification to a user (fire-and-forget) ----
async function notify(userId, text){
  if(!BOT_TOKEN || !userId) return;            // dev mode / no chat id → skip
  const payload = { chat_id:userId, text, disable_web_page_preview:true };
  if(APP_LINK) payload.reply_markup = { inline_keyboard:[[{ text:"⚡ Open Bountly", url:APP_LINK }]] };
  try{
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload)
    });
    if(!r.ok){ const t=await r.text(); console.error("notify failed", r.status, t.slice(0,140)); }
  }catch(e){ console.error("notify error:", e.message); }
}

const DB_FILE  = path.join(__dirname, "data.json");
const UP_DIR   = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if(!fs.existsSync(UP_DIR)) fs.mkdirSync(UP_DIR, { recursive:true });

// ---- storage: Postgres if DATABASE_URL is set, else local JSON file ----
const USE_DB = !!process.env.DATABASE_URL;
let pool = null;
async function initPool(){
  if(!USE_DB) return;
  const pg = (await import("pg")).default;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized:false } : false
  });
}

let db;
function seed(){
  const now=Date.now();
  db={ users:{}, challenges:[], submissions:[], txns:[], seq:{ch:0,sub:0,tx:0} };
  db.challenges.push(
    { id:++db.seq.ch, code:"BNT-001", title:"Dump a bucket of ice water on yourself",
      desc:"Film yourself pouring a full bucket of ice water over your head. Face and bucket must be visible.",
      rules:"Say the code in the video. One take, no cuts. Just you — no bystanders.",
      reward:25, maxWinners:1, creator:"demo", createdAt:now-3600e3 },
    { id:++db.seq.ch, code:"BNT-002", title:"Sing a verse of the anthem in public",
      desc:"Sing the first verse out loud in a public place — a square, park or bus stop.",
      rules:"Say the code. Singing must be audible. Don't film bystanders up close.",
      reward:15, maxWinners:3, creator:"demo", createdAt:now-1800e3 });
}
// persist whole state. In DB mode it's fire-and-forget (in-memory is already updated).
function save(){
  if(USE_DB){ persist().catch(e=>console.error("DB save error:", e.message)); }
  else { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
}
async function persist(){
  await pool.query(
    "INSERT INTO app_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb",
    [JSON.stringify(db)]
  );
}
async function initStore(){
  if(USE_DB){
    await initPool();
    await pool.query("CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)");
    const r = await pool.query("SELECT data FROM app_state WHERE id=1");
    if(r.rows.length){ db = r.rows[0].data; console.log("✓ Loaded state from Postgres"); }
    else { seed(); await persist(); console.log("✓ Seeded fresh Postgres database"); }
  } else {
    try{ db = JSON.parse(fs.readFileSync(DB_FILE,"utf8")); console.log("✓ Loaded local data.json"); }
    catch(e){ seed(); fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); console.log("✓ Created local data.json"); }
  }
}

// ---- Telegram auth ----
function verifyTelegram(initData){
  if(!BOT_TOKEN) return { ok:false, error:"server BOT_TOKEN not set" };

  const params=new URLSearchParams(initData);
  const hash=params.get("hash"); if(!hash) return { ok:false, error:"no hash" };
  params.delete("hash");
  const dataCheck=[...params.entries()].map(([k,v])=>`${k}=${v}`).sort().join("\n");
  const secret=crypto.createHmac("sha256","WebAppData").update(BOT_TOKEN).digest();
  const calc=crypto.createHmac("sha256",secret).update(dataCheck).digest("hex");
  if(calc!==hash) return { ok:false, error:"bad signature" };
  const authDate=Number(params.get("auth_date")||0);
  if(authDate && (Date.now()/1000-authDate)>86400) return { ok:false, error:"expired" };
  return { ok:true, user:JSON.parse(params.get("user")||"{}") };
}
function ensureUser(tg){
  const id=String(tg.id);
  if(!db.users[id]){ db.users[id]={ id, username:tg.username||("user"+id.slice(-4)), name:tg.first_name||"Hunter",
    credits:START_CREDITS, wins:0, banned:false, isAdmin:ADMIN_IDS.includes(id), joinedAt:Date.now() }; save(); }
  db.users[id].isAdmin=ADMIN_IDS.includes(id); return db.users[id];
}
function getUser(req){
  const initData=req.headers["x-telegram-init"]||"";
  if(!BOT_TOKEN){ const id=req.headers["x-dev-user"]||"dev1"; return { ok:true, user:ensureUser({ id, username:id, first_name:id }) }; }
  const v=verifyTelegram(initData); if(!v.ok) return { ok:false, error:v.error };
  return { ok:true, user:ensureUser(v.user) };
}

const winnersOf = ch => db.submissions.filter(s=>s.chId===ch.id&&s.status==="approved").sort((a,b)=>a.at-b.at).slice(0,ch.maxWinners);
const stats = ch => { const subs=db.submissions.filter(s=>s.chId===ch.id&&s.status!=="rejected"); const w=winnersOf(ch);
  return { subs:subs.length, winners:w, full:w.length>=ch.maxWinners, pending:subs.filter(s=>s.status==="pending").length }; };
const tx = (type,from,to,amount,note)=>db.txns.push({ id:++db.seq.tx, at:Date.now(), type, from, to, amount, note });
const pub = u => ({ id:u.id, username:u.username, name:u.name, credits:u.credits, wins:u.wins, isAdmin:u.isAdmin, banned:u.banned });
const json=(res,code,obj)=>{ res.writeHead(code,{ "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,X-Telegram-Init,X-Dev-User","Access-Control-Allow-Methods":"GET,POST,OPTIONS" }); res.end(JSON.stringify(obj)); };

function challengeView(ch){ const st=stats(ch);
  return { id:ch.id, code:ch.code, title:ch.title, desc:ch.desc, rules:ch.rules, reward:ch.reward,
    maxWinners:ch.maxWinners, creator:ch.creator, slots:[st.winners.length,ch.maxWinners], full:st.full,
    subs:st.subs, pending:st.pending, winners:st.winners.map(w=>({player:w.player,at:w.at})) }; }

// ---- multipart parser (minimal, for single video file) ----
async function readBody(req){ const chunks=[]; let total=0;
  for await (const c of req){ total+=c.length; if(total>MAX_VIDEO+1024*1024) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks); }
function parseMultipart(buf, contentType){
  const m=/boundary=(.+)$/.exec(contentType||""); if(!m) return {};
  const boundary="--"+m[1]; const parts={}; const files={};
  let start=buf.indexOf(boundary);
  while(start!==-1){
    const next=buf.indexOf(boundary, start+boundary.length);
    if(next===-1) break;
    let seg=buf.slice(start+boundary.length, next);
    // strip leading CRLF
    if(seg[0]===0x0d && seg[1]===0x0a) seg=seg.slice(2);
    const hdrEnd=seg.indexOf("\r\n\r\n");
    if(hdrEnd!==-1){
      const header=seg.slice(0,hdrEnd).toString();
      let content=seg.slice(hdrEnd+4);
      if(content.length>=2 && content[content.length-2]===0x0d && content[content.length-1]===0x0a) content=content.slice(0,-2);
      const nameM=/name="([^"]+)"/.exec(header);
      const fileM=/filename="([^"]*)"/.exec(header);
      if(nameM){
        if(fileM && fileM[1]){ files[nameM[1]]={ filename:fileM[1], data:content }; }
        else { parts[nameM[1]]=content.toString(); }
      }
    }
    start=next;
  }
  return { parts, files };
}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`); const p=url.pathname;
  if(req.method==="OPTIONS") return json(res,204,{});

  if(p.startsWith("/api/")){
    const ct=req.headers["content-type"]||"";
    let body={}, files={};
    if(req.method==="POST"){
      try{
        const raw=await readBody(req);
        if(ct.includes("multipart/form-data")){ const r=parseMultipart(raw,ct); body=r.parts||{}; files=r.files||{}; }
        else { try{ body=JSON.parse(raw.toString()||"{}"); }catch(e){ body={}; } }
      }catch(e){ return json(res,413,{error:"upload too large (max 50MB)"}); }
    }
    const g=getUser(req); if(!g.ok) return json(res,401,{ error:"unauthorized: "+g.error });
    const u=g.user;

    if(p==="/api/me") return json(res,200,{ user:pub(u) });

    // my activity: my challenges, my submissions, my transactions
    if(p==="/api/me/activity"){
      const myCh=db.challenges.filter(c=>c.creator===u.username).map(challengeView);
      const mySubs=db.submissions.filter(s=>s.userId===u.id).sort((a,b)=>b.at-a.at).map(s=>{
        const ch=db.challenges.find(c=>c.id===s.chId);
        const won=ch && winnersOf(ch).some(w=>w.id===s.id);
        return { id:s.id, code:ch&&ch.code, title:ch&&ch.title, file:s.file, video:s.video, hasVideo:!!s.video, status:s.status, reason:s.reason, at:s.at, won:!!won };
      });
      const myTx=db.txns.filter(t=>t.from===u.username||t.to===u.username).sort((a,b)=>b.at-a.at).slice(0,30);
      return json(res,200,{ challenges:myCh, submissions:mySubs, txns:myTx });
    }

    if(p==="/api/challenges" && req.method==="GET")
      return json(res,200,{ challenges: db.challenges.map(challengeView).sort((a,b)=>b.id-a.id) });

    // single challenge detail
    let m=p.match(/^\/api\/challenges\/(\d+)$/);
    if(m && req.method==="GET"){
      const ch=db.challenges.find(c=>c.id===Number(m[1])); if(!ch) return json(res,404,{error:"not found"});
      const view=challengeView(ch);
      view.mySubmission = db.submissions.find(s=>s.chId===ch.id&&s.userId===u.id&&s.status!=="rejected") ? true : false;
      return json(res,200,{ challenge:view });
    }

    if(p==="/api/challenges" && req.method==="POST"){
      if(u.banned) return json(res,403,{error:"banned"});
      const rw=Math.max(0,Math.floor(Number(body.reward)||0));
      const n=Math.max(1,Math.min(20,Math.floor(Number(body.maxWinners)||1)));
      if(!body.title||!body.desc||rw<1) return json(res,400,{error:"title, desc and reward required"});
      const total=rw*n, fee=Math.round(total*CREATOR_FEE);
      if(u.credits<total+fee) return json(res,400,{error:`not enough credits (need ${total+fee}, have ${u.credits})`});
      u.credits-=(total+fee);
      const id=++db.seq.ch, code="BNT-"+String(id).padStart(3,"0");
      db.challenges.push({ id, code, title:String(body.title).slice(0,120), desc:String(body.desc).slice(0,500),
        rules:String(body.rules||"Say the code in the video.").slice(0,400), reward:rw, maxWinners:n, creator:u.username, createdAt:Date.now() });
      tx("escrow",u.username,"escrow",total,code); tx("fee",u.username,"platform",fee,code+" 5%"); save();
      return json(res,200,{ ok:true, code, locked:total+fee, credits:u.credits });
    }

    // submit proof — now accepts a real video file (multipart) OR a filename (json, demo)
    m=p.match(/^\/api\/challenges\/(\d+)\/submit$/);
    if(m && req.method==="POST"){
      if(u.banned) return json(res,403,{error:"banned"});
      const ch=db.challenges.find(c=>c.id===Number(m[1])); if(!ch) return json(res,404,{error:"not found"});
      if(ch.creator===u.username) return json(res,403,{error:"you can't complete your own dare"});
      if(stats(ch).full) return json(res,400,{error:"slots full"});
      if(db.submissions.find(s=>s.chId===ch.id&&s.userId===u.id&&s.status!=="rejected")) return json(res,400,{error:"you already submitted to this dare"});
      const id=++db.seq.sub;
      let videoName=null, fileLabel="";
      if(files.video){
        const ext=(path.extname(files.video.filename)||".mp4").toLowerCase().slice(0,6).replace(/[^.\w]/g,"");
        videoName=`sub_${id}${ext}`;
        fs.writeFileSync(path.join(UP_DIR, videoName), files.video.data);
        fileLabel=files.video.filename.slice(0,120);
      } else { fileLabel=String((body&&body.file)||`video_${id}.mp4`).slice(0,120); }
      db.submissions.push({ id, chId:ch.id, player:u.username, userId:u.id, file:fileLabel, video:videoName,
        at:Date.now(), status:"pending", reason:"" });
      save();
      // notify the dare creator
      const creatorU = Object.values(db.users).find(x=>x.username===ch.creator);
      if(creatorU && creatorU.id!==u.id) notify(creatorU.id, `🎬 New proof on your dare ${ch.code} — "${ch.title}"\nfrom @${u.username}. Someone's going for your bounty!`);
      return json(res,200,{ ok:true, submissionId:id, hasVideo:!!videoName });
    }

    if(p==="/api/leaderboard"){
      const earn={}; db.txns.filter(t=>t.type==="payout").forEach(t=>earn[t.to]=(earn[t.to]||0)+t.amount);
      const rows=Object.values(db.users).filter(x=>!x.isAdmin).map(x=>({ username:x.username, wins:x.wins, earned:earn[x.username]||0 }))
        .sort((a,b)=>b.wins-a.wins||b.earned-a.earned).slice(0,20);
      return json(res,200,{ leaderboard:rows });
    }

    // ----- admin -----
    if(p==="/api/admin/queue"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const q=db.submissions.filter(s=>s.status==="pending").sort((a,b)=>a.at-b.at)
        .map(s=>{ const ch=db.challenges.find(c=>c.id===s.chId);
          return { id:s.id, player:s.player, file:s.file, video:s.video, at:s.at, code:ch&&ch.code, title:ch&&ch.title }; });
      return json(res,200,{ queue:q });
    }
    m=p.match(/^\/api\/admin\/approve\/(\d+)$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const sub=db.submissions.find(s=>s.id===Number(m[1])); if(!sub||sub.status!=="pending") return json(res,404,{error:"not found"});
      const ch=db.challenges.find(c=>c.id===sub.chId); sub.status="approved";
      const won=winnersOf(ch).some(w=>w.id===sub.id);
      if(won){ const payout=Math.round(ch.reward*(1-PLAYER_FEE)), fee=ch.reward-payout;
        const w=Object.values(db.users).find(x=>x.username===sub.player); if(w){ w.credits+=payout; w.wins+=1; }
        tx("payout","escrow",sub.player,payout,ch.code); tx("commission","escrow","platform",fee,ch.code+" 10%");
        notify(sub.userId, `🏆 Your proof for ${ch.code} was approved — you won ${payout} cr! 🎉\n"${ch.title}"`);
      } else {
        notify(sub.userId, `✅ Your proof for ${ch.code} was approved, but the slot was already taken by a faster hunter. Keep going!`);
      }
      save(); return json(res,200,{ ok:true, winner:won });
    }
    m=p.match(/^\/api\/admin\/reject\/(\d+)$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const sub=db.submissions.find(s=>s.id===Number(m[1])); if(!sub||sub.status!=="pending") return json(res,404,{error:"not found"});
      const reason=String(body.reason||"").slice(0,200); if(!reason) return json(res,400,{error:"reason required"});
      const ch=db.challenges.find(c=>c.id===sub.chId);
      sub.status="rejected"; sub.reason=reason; save();
      notify(sub.userId, `❌ Your proof for ${ch?ch.code:"a dare"} was rejected.\nReason: ${reason}\nYou can try again on this dare.`);
      return json(res,200,{ ok:true });
    }

    // ===== ADMIN MANAGEMENT =====
    // all users
    if(p==="/api/admin/users"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const earn={}; db.txns.filter(t=>t.type==="payout").forEach(t=>earn[t.to]=(earn[t.to]||0)+t.amount);
      const users=Object.values(db.users).sort((a,b)=>b.joinedAt-a.joinedAt).map(x=>({
        id:x.id, username:x.username, name:x.name, credits:x.credits, wins:x.wins,
        banned:!!x.banned, isAdmin:!!x.isAdmin, earned:earn[x.username]||0, joinedAt:x.joinedAt,
        posted:db.challenges.filter(c=>c.creator===x.username).length,
        subs:db.submissions.filter(s=>s.userId===x.id).length }));
      return json(res,200,{ users });
    }
    // ban / unban a user
    m=p.match(/^\/api\/admin\/ban\/([^/]+)$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const tu=db.users[m[1]]; if(!tu) return json(res,404,{error:"user not found"});
      if(tu.isAdmin) return json(res,400,{error:"can't ban an admin"});
      tu.banned=!tu.banned; save(); return json(res,200,{ ok:true, banned:tu.banned });
    }
    // set a user's credits
    m=p.match(/^\/api\/admin\/credits\/([^/]+)$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const tu=db.users[m[1]]; if(!tu) return json(res,404,{error:"user not found"});
      const v=Math.max(0,Math.floor(Number(body.credits))); if(!Number.isFinite(v)) return json(res,400,{error:"bad value"});
      tu.credits=v; tx("admin-adjust","platform",tu.username,v,"set credits"); save();
      return json(res,200,{ ok:true, credits:tu.credits });
    }
    // all challenges (admin)
    if(p==="/api/admin/challenges"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const list=db.challenges.map(ch=>{ const st=stats(ch);
        return { id:ch.id, code:ch.code, title:ch.title, creator:ch.creator, reward:ch.reward,
          maxWinners:ch.maxWinners, slots:[st.winners.length,ch.maxWinners], subs:st.subs, pending:st.pending,
          createdAt:ch.createdAt }; }).sort((a,b)=>b.id-a.id);
      return json(res,200,{ challenges:list });
    }
    // edit a challenge (text only)
    m=p.match(/^\/api\/admin\/challenge\/(\d+)\/edit$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const ch=db.challenges.find(c=>c.id===Number(m[1])); if(!ch) return json(res,404,{error:"not found"});
      if(body.title!=null) ch.title=String(body.title).slice(0,120);
      if(body.desc!=null) ch.desc=String(body.desc).slice(0,500);
      if(body.rules!=null) ch.rules=String(body.rules).slice(0,400);
      save(); return json(res,200,{ ok:true });
    }
    // delete a challenge (refund unspent escrow to creator, remove its submissions)
    m=p.match(/^\/api\/admin\/challenge\/(\d+)\/delete$/);
    if(m && req.method==="POST"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const idx=db.challenges.findIndex(c=>c.id===Number(m[1])); if(idx<0) return json(res,404,{error:"not found"});
      const ch=db.challenges[idx];
      const wonCount=winnersOf(ch).length;
      const refund=Math.max(0, ch.reward*(ch.maxWinners-wonCount));
      const creator=Object.values(db.users).find(x=>x.username===ch.creator);
      if(creator && refund>0){ creator.credits+=refund; tx("refund","escrow",ch.creator,refund,ch.code+" deleted"); }
      // remove submissions + their video files
      db.submissions.filter(s=>s.chId===ch.id).forEach(s=>{ if(s.video){ try{ fs.unlinkSync(path.join(UP_DIR,s.video)); }catch(e){} } });
      db.submissions = db.submissions.filter(s=>s.chId!==ch.id);
      db.challenges.splice(idx,1);
      save(); return json(res,200,{ ok:true, refunded:refund });
    }
    // full transaction ledger
    if(p==="/api/admin/txns"){
      if(!u.isAdmin) return json(res,403,{error:"admin only"});
      const txns=[...db.txns].sort((a,b)=>b.at-a.at).slice(0,200);
      return json(res,200,{ txns });
    }

    return json(res,404,{ error:"unknown endpoint" });
  }

  // ---- serve uploaded videos ----
  if(p.startsWith("/uploads/")){
    const f=path.join(UP_DIR, path.basename(p));
    return fs.readFile(f,(err,data)=>{ if(err){res.writeHead(404);return res.end("not found");}
      const ext=path.extname(f).toLowerCase();
      const types={".mp4":"video/mp4",".mov":"video/quicktime",".webm":"video/webm",".avi":"video/x-msvideo"};
      res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream"}); res.end(data); });
  }

  // ---- static (mini app) ----
  let file = p==="/" ? "/index.html" : p;
  file=path.join(__dirname, path.normalize(file).replace(/^(\.\.[\/\\])+/,""));
  fs.readFile(file,(err,data)=>{
    if(err){ res.writeHead(404); return res.end("Not found"); }
    const ext=path.extname(file).toLowerCase();
    const types={ ".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json" };
    res.writeHead(200,{ "Content-Type":types[ext]||"application/octet-stream" }); res.end(data);
  });
});
server.listen; // (defined below after store init)

initStore()
  .then(()=> server.listen(PORT, ()=>console.log(
    `Bountly running on http://localhost:${PORT}  · storage: ${USE_DB?"Postgres":"local JSON"}  · uploads: ${UP_DIR}  · BOT_TOKEN ${BOT_TOKEN?"set":"NOT set (DEV mode)"}`)))
  .catch(e=>{ console.error("Startup failed:", e.message); process.exit(1); });
