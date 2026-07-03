// ============================================================
// BOUNTLY — Solana per-user USDC deposits (Helius, devnet-first).
//
// MODEL: each user gets a unique deposit address derived from ONE master
// mnemonic (operator-held; never hardcoded, read from env). A user sends
// USDC to their address (NO memo). A Helius webhook pings the server, which
// then INDEPENDENTLY re-reads the transaction from an RPC at `finalized`
// commitment and verifies it before crediting. Funds are swept to a hot
// wallet (fee-payer), so per-user addresses never need pre-funded SOL.
//
// SECURITY — never trust the webhook payload or the client:
//   • credit only from an on-chain tx read via RPC at `finalized`
//   • verify the SPL mint == canonical USDC mint (reject look-alike tokens)
//   • verify the credited owner == the user's derived deposit address
//   • idempotency by tx signature (unique index on ledger_tx.ref)
//   • enforce a minimum deposit; read amounts using the mint's decimals
//
// Flag-gated by SOLANA=1. Heavy libs (@solana/*) are lazy-imported so the
// app runs untouched when the flag is off.
// ============================================================
import * as wallet from './wallet.js';

// ---- config (all via environment) ----
export const cfg = () => {
  const net = process.env.SOLANA_NETWORK || 'devnet';
  const key = process.env.HELIUS_API_KEY || '';
  const rpc = process.env.SOLANA_RPC || (net === 'mainnet'
    ? 'https://mainnet.helius-rpc.com/?api-key=' + key
    : 'https://devnet.helius-rpc.com/?api-key=' + key);
  return {
    network: net,
    rpc,
    heliusKey: key,
    webhookSecret: process.env.HELIUS_WEBHOOK_SECRET || '',
    // Canonical USDC mints. Devnet default = Circle's devnet USDC (confirm before use).
    usdcMint: process.env.USDC_MINT || (net === 'mainnet'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    decimals: Number(process.env.USDC_DECIMALS || 6),
    minDeposit: Number(process.env.MIN_DEPOSIT_USDC || 0.5),
    hotIndex: 0, // master index 0 = hot wallet / fee-payer / treasury
    configured: !!(process.env.SOLANA_MASTER_MNEMONIC && key),
  };
};

// ============================================================
// PURE verification logic (no network, no libs) — unit-tested.
// ============================================================

// From a confirmed tx's token-balance changes, return the USDC amount
// (in whole USDC) credited to `owner`'s account for `mint`, else 0.
// pre/post are arrays shaped like Solana's meta.{pre,post}TokenBalances:
//   { accountIndex, mint, owner, uiTokenAmount: { amount /*raw string*/, decimals } }
export function usdcCredited(pre, post, { owner, mint, decimals }) {
  pre = Array.isArray(pre) ? pre : [];
  post = Array.isArray(post) ? post : [];
  const raw = (arr, idx) => {
    const e = arr.find(x => x.accountIndex === idx);
    return e ? BigInt(e.uiTokenAmount.amount || '0') : 0n;
  };
  let credited = 0n;
  for (const p of post) {
    if (p.mint !== mint) continue;            // wrong token → ignore (fake USDC guard)
    if (p.owner !== owner) continue;          // credited to someone else → ignore
    if (p.uiTokenAmount.decimals !== decimals) continue; // decimals mismatch → ignore
    const delta = raw(post, p.accountIndex) - raw(pre, p.accountIndex);
    if (delta > 0n) credited += delta;        // only inbound
  }
  return Number(credited) / 10 ** decimals;
}

// Decide whether a parsed transaction should credit `owner`.
// `tx` is a getTransaction JSON result. Returns {credit, amount, reason}.
export function evaluateDeposit(tx, { owner, mint, decimals, min, finalized = true }) {
  if (!tx || !tx.meta) return { credit: false, reason: 'no tx' };
  if (tx.meta.err) return { credit: false, reason: 'tx failed' };
  if (!finalized) return { credit: false, reason: 'not finalized' };
  const amount = usdcCredited(tx.meta.preTokenBalances, tx.meta.postTokenBalances, { owner, mint, decimals });
  if (amount <= 0) return { credit: false, reason: 'no matching USDC credit' };
  if (amount < min) return { credit: false, reason: 'below minimum', amount };
  return { credit: true, amount, reason: 'ok' };
}

// Constant-time-ish check of the Helius webhook auth header.
export function webhookAuthorized(headers, secret) {
  if (!secret) return false; // fail closed: require a configured secret
  const got = (headers && (headers['authorization'] || headers['Authorization'])) || '';
  return got === secret;
}

// ============================================================
// Key derivation (lazy libs). Private keys are derived on demand and
// never stored — only the per-user index + public address live in the DB.
// ============================================================
async function _libs() {
  const web3 = await import('@solana/web3.js');
  const bip39 = await import('bip39');
  const { derivePath } = await import('ed25519-hd-key');
  return { web3, bip39, derivePath };
}

export async function deriveKeypair(index) {
  const mn = process.env.SOLANA_MASTER_MNEMONIC;
  if (!mn) throw new Error('SOLANA_MASTER_MNEMONIC not set');
  const { web3, bip39, derivePath } = await _libs();
  const seed = await bip39.mnemonicToSeed(mn.trim());
  const path = `m/44'/501'/${Number(index)}'/0'`;
  const { key } = derivePath(path, seed.toString('hex'));
  return web3.Keypair.fromSeed(key);
}

export async function depositAddress(index) {
  return (await deriveKeypair(index)).publicKey.toBase58();
}

// ============================================================
// Chain reads / credit (network). Isolated so the logic above stays pure.
// ============================================================
async function _rpc(method, params) {
  const c = cfg();
  const r = await fetch(c.rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error('RPC ' + method + ': ' + JSON.stringify(j.error));
  return j.result;
}

// Verify a signature on-chain and credit the ledger (idempotent by signature).
// `ownerIndex`/`ownerAddress` identify whose deposit address received funds;
// `username` is the ledger account key to credit.
export async function verifyAndCredit(pool, { signature, ownerAddress, username, log = console }) {
  const c = cfg();
  const seen = await pool.query(
    `SELECT 1 FROM ledger_tx WHERE type='deposit' AND ref=$1 LIMIT 1`, [signature]);
  if (seen.rows.length) return { credited: false, reason: 'already credited' };

  const tx = await _rpc('getTransaction', [signature,
    { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  const verdict = evaluateDeposit(tx, {
    owner: ownerAddress, mint: c.usdcMint, decimals: c.decimals, min: c.minDeposit, finalized: !!tx });
  if (!verdict.credit) return { credited: false, reason: verdict.reason, amount: verdict.amount };

  try {
    await wallet.withClient(pool, cl => wallet.deposit(cl, String(username).trim(), verdict.amount, signature));
    log.log?.(`solana deposit ${verdict.amount} USDC -> @${username} (${String(signature).slice(0, 12)})`);
    return { credited: true, amount: verdict.amount, username };
  } catch (e) {
    if (/duplicate key|unique|uniq_deposit_ref/i.test(e.message)) return { credited: false, reason: 'already credited' };
    throw e;
  }
}

// ============================================================
// Per-user deposit-address registry (Postgres). Only the index + public
// address are stored — never a private key. Index 0 is reserved for the
// hot wallet, so user indices start at 1.
// ============================================================
export async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS solana_addr (
    idx        bigint PRIMARY KEY,
    username   text UNIQUE NOT NULL,
    address    text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`);
}

export async function allocateAddress(pool, username) {
  const c = cfg();
  if (!c.configured) return null;
  await ensureSchema(pool);
  const u = String(username).trim();
  const ex = await pool.query(`SELECT address FROM solana_addr WHERE username=$1`, [u]);
  if (ex.rows.length) return ex.rows[0].address;
  for (let attempt = 0; attempt < 6; attempt++) {
    const n = await pool.query(`SELECT COALESCE(MAX(idx),0)+1 AS idx FROM solana_addr`);
    const idx = Math.max(1, Number(n.rows[0].idx));
    const addr = await depositAddress(idx);
    try {
      await pool.query(`INSERT INTO solana_addr(idx, username, address) VALUES($1,$2,$3)`, [idx, u, addr]);
      registerAddressWithHelius(addr).catch(() => {});
      return addr;
    } catch (e) {
      if (/duplicate|unique/i.test(e.message)) {
        const again = await pool.query(`SELECT address FROM solana_addr WHERE username=$1`, [u]);
        if (again.rows.length) return again.rows[0].address; // concurrent create
        continue; // idx race — retry with a fresh max
      }
      throw e;
    }
  }
  throw new Error('could not allocate solana address');
}

export async function addressToUser(pool, address) {
  const r = await pool.query(`SELECT username, idx FROM solana_addr WHERE address=$1`, [address]);
  return r.rows[0] || null;
}

// Best-effort: add a new deposit address to the Helius webhook's watch list.
// No-op (manual registration) unless HELIUS_WEBHOOK_ID is set. Never throws.
export async function registerAddressWithHelius(address) {
  const c = cfg();
  const id = process.env.HELIUS_WEBHOOK_ID;
  if (!c.heliusKey || !id) return false;
  const url = `https://api.helius.xyz/v0/webhooks/${id}?api-key=${c.heliusKey}`;
  const cur = await (await fetch(url)).json();
  const addrs = Array.from(new Set([...(cur.accountAddresses || []), address]));
  await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookURL: cur.webhookURL, transactionTypes: cur.transactionTypes,
      accountAddresses: addrs, webhookType: cur.webhookType, authHeader: cur.authHeader }) });
  return true;
}

// Handle a Helius webhook POST. Verifies the shared secret, then for every
// USDC transfer to one of OUR deposit addresses, re-verifies on-chain and
// credits (idempotent). Returns {ok, credited} or {ok:false, status}.
export async function handleWebhook(pool, { headers, body, log = console }) {
  const c = cfg();
  if (!webhookAuthorized(headers, c.webhookSecret)) return { ok: false, status: 401 };
  const events = Array.isArray(body) ? body : (body ? [body] : []);
  let credited = 0;
  for (const ev of events) {
    const sig = ev.signature || ev.transactionSignature;
    if (!sig) continue;
    const owners = new Set();
    for (const t of (ev.tokenTransfers || [])) {
      if (t && t.mint === c.usdcMint && t.toUserAccount) owners.add(t.toUserAccount);
    }
    for (const owner of owners) {
      const u = await addressToUser(pool, owner);
      if (!u) continue;
      try {
        const r = await verifyAndCredit(pool, { signature: sig, ownerAddress: owner, username: u.username, log });
        if (r.credited) credited++;
      } catch (e) { log.error?.('solana credit error', e.message); }
    }
  }
  return { ok: true, credited };
}

// ============================================================
// Sweep: move received USDC from a user's ATA to the hot-wallet ATA.
// Signed by the re-derived deposit keypair; fee-payer = hot wallet, so the
// user address needs no SOL. NB: validate on devnet before mainnet.
// ============================================================
export async function sweep({ fromIndex, log = console }) {
  const c = cfg();
  const { web3 } = await _libs();
  const spl = await import('@solana/spl-token');
  const conn = new web3.Connection(c.rpc, 'confirmed');
  const from = await deriveKeypair(fromIndex);
  const hot = await deriveKeypair(c.hotIndex);
  const mint = new web3.PublicKey(c.usdcMint);
  const fromAta = await spl.getAssociatedTokenAddress(mint, from.publicKey);
  const hotAta = await spl.getAssociatedTokenAddress(mint, hot.publicKey);
  const bal = await conn.getTokenAccountBalance(fromAta).catch(() => null);
  const amount = bal && bal.value ? BigInt(bal.value.amount) : 0n;
  if (amount <= 0n) return { swept: false, reason: 'nothing to sweep' };
  const ix = spl.createTransferInstruction(fromAta, hotAta, from.publicKey, amount);
  const tx = new web3.Transaction().add(ix);
  tx.feePayer = hot.publicKey; // hot wallet pays fees
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [hot, from]);
  log.log?.(`swept ${amount} (raw) from idx ${fromIndex} → hot (${sig.slice(0, 12)})`);
  return { swept: true, signature: sig, amount: Number(amount) / 10 ** c.decimals };
}
