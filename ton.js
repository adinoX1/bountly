// ============================================================
// BOUNTLY — TON (testnet-first) deposits & withdrawals.
//
// DEPOSITS (safe, read-only on-chain): pollDeposits() asks a toncenter
// API for incoming USDT (jetton) transfers to the platform deposit
// address, reads the text comment (= the depositing @username), and
// credits the ledger via creditConfirmedDeposit() — which is IDEMPOTENT
// (a given on-chain tx hash credits at most once, also enforced by a
// unique index). Needs no private key.
//
// WITHDRAWALS (sensitive): the on-chain send signs with WALLET_MNEMONIC,
// which YOU set as an env var — never handled by the assistant.
// sendUsdt() must be validated on testnet before any real funds.
//
// Env: TON_NETWORK=testnet, TON_API, TON_API_KEY, DEPOSIT_ADDRESS,
//      USDT_JETTON_MASTER, WALLET_MNEMONIC, USDT_DECIMALS=6
// ============================================================
import * as wallet from './wallet.js';

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
    configured: !!(process.env.DEPOSIT_ADDRESS && process.env.USDT_JETTON_MASTER),
  };
};

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

// Poll toncenter for incoming jetton transfers and credit them.
// NOTE: verify the response field names against your testnet.
export async function pollDeposits(pool, log = console) {
  const c = cfg();
  if (!c.configured) return { ok: false, reason: 'TON not configured' };
  const url = `${c.api}/jetton/transfers?address=${encodeURIComponent(c.deposit)}`
            + `&direction=in&jetton_master=${encodeURIComponent(c.jetton)}&limit=50`;
  let data;
  try {
    const r = await fetch(url, { headers: c.apiKey ? { 'X-API-Key': c.apiKey } : {} });
    if (!r.ok) { log.error?.('toncenter HTTP', r.status); return { ok: false, status: r.status }; }
    data = await r.json();
  } catch (e) { log.error?.('toncenter fetch', e.message); return { ok: false, error: e.message }; }

  const transfers = data.jetton_transfers || data.transfers || [];
  let credited = 0;
  for (const t of transfers) {
    const txhash = t.transaction_hash || t.trace_id || t.transaction_id;
    const username = decodeComment(t.forward_payload) || t.comment || '';
    const amountUsdt = rawToUsdt(t.amount || '0', c.decimals);
    if (!txhash || !username || !(amountUsdt > 0)) continue;
    try {
      const res = await creditConfirmedDeposit(pool, { txhash, username, amountUsdt });
      if (res.credited) { credited++; log.log?.(`deposit ${amountUsdt} USDT -> @${username} (${String(txhash).slice(0, 12)})`); }
    } catch (e) { log.error?.('credit error', e.message); }
  }
  return { ok: true, scanned: transfers.length, credited };
}

// Run the poller on an interval (call once at startup).
export function startDepositWatcher(pool, everyMs = 30000, log = console) {
  const c = cfg();
  if (!c.configured) { log.warn?.('TON deposit watcher off (set DEPOSIT_ADDRESS + USDT_JETTON_MASTER)'); return null; }
  log.log?.(`TON deposit watcher on (${c.network}, every ${everyMs / 1000}s)`);
  const tick = () => pollDeposits(pool, log).catch(e => log.error?.('poll', e.message));
  tick();
  return setInterval(tick, everyMs);
}

// ---- WITHDRAWAL (signs with WALLET_MNEMONIC you provide; testnet-first) ----
export async function sendUsdt({ toAddress, amountUsdt }) {
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
  return { ok: true, seqno };
}
