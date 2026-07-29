// ============================================================
// BOUNTLY — TON (testnet-first) deposits & withdrawals.
//
// DEPOSITS (safe, read-only on-chain): pollDeposits() asks a toncenter
// API for incoming USDT (jetton) transfers to the platform deposit
// address and reads the text comment (= the depositing @username). It
// does NOT credit on sight — a transfer is recorded in deposit_watch
// and only credited once its masterchain block is TON_MIN_CONFIRMATIONS
// deep (see deposits.js). Crediting stays IDEMPOTENT: a given tx hash
// credits at most once, also enforced by a unique index. No private key
// is involved anywhere on this path.
//
// WITHDRAWALS (sensitive): the on-chain send signs with WALLET_MNEMONIC,
// which YOU set as an env var — never handled by the assistant.
// sendUsdt() must be validated on testnet before any real funds.
//
// Env: TON_NETWORK=testnet, TON_API, TON_API_KEY, DEPOSIT_ADDRESS,
//      USDT_JETTON_MASTER, WALLET_MNEMONIC, USDT_DECIMALS=6,
//      TON_MIN_CONFIRMATIONS=1
// ============================================================
import * as wallet from './wallet.js';
import * as D from './deposits.js';

export const cfg = () => {
  const net = process.env.TON_NETWORK || 'testnet';
  return {
    network: net,
    api: process.env.TON_API || (net === 'mainnet'
      ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3'),
    apiKey: process.env.TON_API_KEY || '',
    deposit: process.env.DEPOSIT_ADDRESS || '',
    jetton: process.env.USDT_JETTON_MASTER || '',
    decimals: Number(process.env.USDT_DECIMALS || 6),
    // How deep the masterchain block holding a transfer must be before we
    // spend money on it. TON finalises in one block, so 1 is the honest
    // default; raise it if you want a bigger margin.
    minConfirms: Math.max(1, Number(process.env.TON_MIN_CONFIRMATIONS || 1)),
    configured: !!(process.env.DEPOSIT_ADDRESS && process.env.USDT_JETTON_MASTER),
  };
};

const authHeaders = () => { const c = cfg(); return c.apiKey ? { 'X-API-Key': c.apiKey } : {}; };

async function api(path) {
  const c = cfg();
  const r = await fetch(`${c.api}${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`toncenter HTTP ${r.status}`);
  return r.json();
}

const rawToUsdt = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;

// Idempotent: credit a user for ONE confirmed on-chain deposit.
export async function creditConfirmedDeposit(pool, { txhash, username, amountUsdt }) {
  if (!txhash || !username || !(amountUsdt > 0)) throw new Error('bad deposit args');
  const seen = await pool.query(`SELECT 1 FROM ledger_tx WHERE type='deposit' AND ref=$1 LIMIT 1`, [txhash]);
  if (seen.rows.length) return { credited: false, reason: 'already credited' };
  try {
    await wallet.withClient(pool, c => wallet.deposit(c, String(username).trim(), amountUsdt, txhash));
    return { credited: true, amountUsdt, username };
  } catch (e) {
    if (/duplicate key|unique|uniq_deposit_ref/i.test(e.message)) return { credited: false, reason: 'already credited' };
    throw e;
  }
}

// Best-effort decode of a TON text comment from a base64 body cell.
export function decodeComment(b64) {
  if (!b64 || typeof b64 !== 'string') return '';
  try {
    const buf = Buffer.from(b64, 'base64');
    const start = (buf.length >= 4 && buf.readUInt32BE(0) === 0) ? 4 : 0;
    return buf.slice(start).toString('utf8').replace(/[\x00- ]+$/, '').trim();
  } catch { return ''; }
}

// toncenter has renamed these fields across versions and the shape differs
// between v2 and v3. Normalising here keeps the tolerance in one tested
// place instead of scattered through the polling loop.
export function transferFields(t, decimals = 6) {
  if (!t || typeof t !== 'object') return null;
  const txhash = t.transaction_hash || t.trace_id || t.transaction_id || '';
  const username = decodeComment(t.forward_payload) || t.comment || '';
  let amountUsdt = 0;
  try { amountUsdt = rawToUsdt(t.amount || '0', decimals); } catch { amountUsdt = 0; }
  const seqno = Number(t.mc_block_seqno ?? t.masterchain_seqno ?? t.block_seqno ?? 0);
  if (!txhash || !username || !(amountUsdt > 0)) return null;
  return { txhash, username, amountUsdt, seqno };
}

// The head of the masterchain — the yardstick every confirmation count is
// measured against.
export async function headSeqno() {
  const j = await api('/masterchainInfo');
  return Number(j?.last?.seqno ?? j?.last_seqno ?? j?.seqno ?? 0);
}

// Look one transaction back up by hash: how deep is it, and did it abort?
export async function txState(hash) {
  const j = await api(`/transactions?hash=${encodeURIComponent(hash)}&limit=1`);
  const tx = (j.transactions || j.txs || [])[0];
  if (!tx) return { seen: false, failed: false, confirms: 0 };
  const aborted = !!(tx.description?.aborted ?? tx.aborted);
  if (aborted) return { seen: true, failed: true, confirms: 0, detail: 'transaction aborted on-chain' };
  const seqno = Number(tx.mc_block_seqno ?? tx.masterchain_seqno ?? tx.block_seqno ?? 0);
  return { seen: true, failed: false, confirms: D.tonConfirms(seqno, await headSeqno()) };
}

// Re-read the transfer itself at credit time. The sighting told us what an
// indexer listing claimed; this is the number we actually pay on, and a
// disagreement means we pay nothing.
export async function readTransfer(hash) {
  const c = cfg();
  const j = await api(`/jetton/transfers?address=${encodeURIComponent(c.deposit)}`
    + `&direction=in&jetton_master=${encodeURIComponent(c.jetton)}&limit=100`);
  const list = j.jetton_transfers || j.transfers || [];
  for (const t of list) {
    const f = transferFields(t, c.decimals);
    if (f && f.txhash === hash) return f;
  }
  return null;
}

// The reader deposits.js drives: how confirmed is it, and how do we pay it.
export function reader(pool, log = console) {
  return {
    status: hash => txState(hash),
    credit: async ({ txref, username, amountUsdt }) => {
      const fresh = await readTransfer(txref);
      if (!fresh) {
        log.warn?.(`ton: ${String(txref).slice(0, 12)} confirmed but no longer in the transfer window — not crediting`);
        return { credited: false, reason: 'transfer not found on re-read' };
      }
      if (fresh.username !== username || Math.abs(fresh.amountUsdt - amountUsdt) > 1e-9) {
        return { credited: false, reason: 'on-chain transfer does not match what we saw' };
      }
      return creditConfirmedDeposit(pool, { txhash: txref, username: fresh.username, amountUsdt: fresh.amountUsdt });
    },
  };
}

// Poll toncenter for incoming jetton transfers and WATCH them. Crediting is
// left to the confirmation pass, so a transfer that is visible but not yet
// deep enough shows up to the player as "confirming" instead of silently
// becoming money.
export async function pollDeposits(pool, log = console, hooks = {}) {
  const c = cfg();
  if (!c.configured) return { ok: false, reason: 'TON not configured' };
  const url = `/jetton/transfers?address=${encodeURIComponent(c.deposit)}`
            + `&direction=in&jetton_master=${encodeURIComponent(c.jetton)}&limit=50`;
  let data, head = 0;
  try {
    [data, head] = await Promise.all([api(url), headSeqno().catch(() => 0)]);
  } catch (e) { log.error?.('toncenter fetch', e.message); return { ok: false, error: e.message }; }

  const transfers = data.jetton_transfers || data.transfers || [];
  let watched = 0;
  for (const t of transfers) {
    const f = transferFields(t, c.decimals);
    if (!f) continue;
    try {
      const r = await D.noteSeen(pool, {
        chain: 'ton', txref: f.txhash, username: f.username, amountUsdt: f.amountUsdt,
        confirms: D.tonConfirms(f.seqno, head), need: c.minConfirms,
        detail: `${f.amountUsdt} USDT`,
      });
      if (r.watched) watched++;
    } catch (e) { log.error?.('watch error', e.message); }
  }
  const settled = await D.confirmOpen(pool, { ton: reader(pool, log) }, { log, ...hooks });
  return { ok: true, scanned: transfers.length, watched, credited: settled.credited, confirming: settled.confirming };
}

// Run the poller on an interval (call once at startup). `hooks` carries
// onCredited / onFailed straight through to the confirm pass, which is where
// a deposit stops being a sighting and becomes money somebody should hear about.
export function startDepositWatcher(pool, everyMs = 30000, log = console, hooks = {}) {
  const c = cfg();
  if (!c.configured) { log.warn?.('TON deposit watcher off (set DEPOSIT_ADDRESS + USDT_JETTON_MASTER)'); return null; }
  log.log?.(`TON deposit watcher on (${c.network}, every ${everyMs / 1000}s, ${c.minConfirms} confirmation${c.minConfirms > 1 ? 's' : ''})`);
  const tick = () => pollDeposits(pool, log, hooks).catch(e => log.error?.('poll', e.message));
  tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return t;
}

// ---- WITHDRAWAL (signs with WALLET_MNEMONIC you provide; testnet-first) ----
// Is this a TON address at all? Checked before the ledger is touched, because
// a jetton transfer to a malformed address is money gone with no undo.
// Accepts both user-friendly base64 (EQ…/UQ…) and raw workchain:hex form.
export function isValidAddress(address) {
  if (typeof address !== 'string') return false;
  const s = address.trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(s)) return true;
  if (!/^[A-Za-z0-9_-]{48}$/.test(s)) return false;
  // 48 base64url chars decode to 36 bytes: tag + workchain + 32 hash + crc16.
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 36; }
  catch { return false; }
}

export async function sendUsdt({ toAddress, amountUsdt }) {
  if (!isValidAddress(toAddress)) throw new Error('that is not a valid TON address');
  if (!process.env.WALLET_MNEMONIC) throw new Error('WALLET_MNEMONIC not set (you must provide it; never share it)');
  const c = cfg();
  if (!c.jetton) throw new Error('USDT_JETTON_MASTER not set');
  const { TonClient, WalletContractV4, internal, JettonMaster } = await import('@ton/ton');
  const { mnemonicToPrivateKey } = await import('@ton/crypto');
  const { toNano, beginCell, Address } = await import('@ton/core');

  const client = new TonClient({ endpoint: c.api.replace('/api/v3', '/api/v2/jsonRPC'), apiKey: c.apiKey });
  const key = await mnemonicToPrivateKey(process.env.WALLET_MNEMONIC.split(' '));
  const w = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(w);
  const master = client.open(JettonMaster.create(Address.parse(c.jetton)));
  const myJetton = await master.getWalletAddress(w.address);
  const amount = BigInt(Math.round(amountUsdt * 10 ** c.decimals));

  const body = beginCell()
    .storeUint(0x0f8a7ea5, 32).storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(Address.parse(toAddress))
    .storeAddress(w.address)
    .storeBit(0).storeCoins(toNano('0.01')).storeBit(0)
    .endCell();

  const seqno = await contract.getSeqno();
  await contract.sendTransfer({
    seqno, secretKey: key.secretKey,
    messages: [internal({ to: myJetton, value: toNano('0.1'), body })],
  });
  // sendTransfer does not hand back a hash. The wallet address plus its seqno
  // identifies this transfer exactly once — good enough as the ledger's
  // idempotency key, which is all `ref` has to be.
  return { ok: true, seqno, ref: `ton:${w.address.toString()}:${seqno}` };
}
