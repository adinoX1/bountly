# ⚡ Bountly

A **Telegram Mini App** where people post *dares* (challenges) with a cash bounty,
and others complete them by submitting a short video proof. An admin (or the web
dashboard) reviews each proof and pays out the bounty.

> Balances are dollar-pegged stablecoins — USDT on TON, USDC on Solana — so every
> amount in the UI is shown as dollars. Bounties are posted in whole dollars;
> balances and deposits carry cents.

> Stack: a single dependency-light **Node.js** HTTP server (`server.js`), a Telegram
> Mini App frontend (`index.html`), and a password-protected web dashboard
> (`admin.html`). State lives in **Postgres** when `DATABASE_URL` is set, otherwise a
> local JSON file.

---

## How it works

- **Post a dare** — costs `reward × winners` in escrow + a 5% creator fee.
  Every dare carries a **deadline**; if it passes with no winner the escrow is
  refunded to the creator automatically.
- **Submit a proof** — upload a video (max 50 MB). Each clip is fingerprinted (SHA-256)
  so the same video can't be reused. One live proof per hunter per dare; if yours is
  rejected you can record a new one and try again.
- **Review** — admins approve/reject from inside the app or the web dashboard.
  On approval the fastest valid hunters win; payout is the reward minus a 10% player fee.
- **Appeal** — a rejected hunter can contest the decision once, within a window
  (`APPEAL_WINDOW_HOURS`, default 48). The proof enters a `disputed` state that
  holds the contested slot; a second reviewer either overturns it (pays out) or
  upholds the rejection (final).
- **Leaderboard, profiles, transaction ledger** are all derived from the same state.

### Topping up

With `LEDGER=1` a player funds their balance by sending USDT on TON or USDC on
Solana. Detection is automatic and does not depend on the player telling us
anything:

1. **Spotted.** The TON poller, the Helius webhook, or — with no webhook
   configured at all — a direct poll of the cluster notices a transfer to a
   deposit address. It is recorded as *seen*, never credited on sight.
2. **Confirming.** A pass re-reads the transaction from the chain and tracks
   how settled it is: masterchain depth on TON, `finalized` commitment on
   Solana. The deposit sheet shows the progress live.
3. **Credited.** Only at that point does the ledger move, keyed on the tx hash
   so a transfer credits exactly once. A transfer that aborts, or that never
   confirms, is closed out and the player is told — no money moves either way.

The sheet asks the server to look at the chain while it is open, so a transfer
normally surfaces within seconds rather than at the next background sweep.

---

## Quick start (local)

```bash
npm install
cp .env.example .env      # then edit values (you can leave most blank for dev)
npm start
```

Open <http://localhost:3000>. With no `BOT_TOKEN` the server runs in **DEV mode**:
Telegram auth is bypassed and you're identified by an `X-Dev-User` header (handy for
testing, never for production).

Before committing:

```bash
npm run check   # syntax check every module
npm test        # ledger, migration, wallet, API, chains, HTTP, expiry
```

---

## Configuration

All configuration is via environment variables — see **`.env.example`** for the full,
documented list. The important ones:

| Variable         | Required        | Purpose                                                        |
|------------------|-----------------|----------------------------------------------------------------|
| `BOT_TOKEN`      | yes (prod)      | Telegram bot token; enables real `initData` auth.              |
| `PUBLIC_URL`     | for bot cmds    | Public https origin. Without it the webhook isn't registered.  |
| `ADMIN_IDS`      | recommended     | Comma-separated Telegram IDs that get in-app admin powers.     |
| `ADMIN_PASSWORD` | for dashboard   | Password for the `/admin` web dashboard. Empty = disabled.     |
| `DATABASE_URL`   | for persistence | Postgres connection string. Falls back to a JSON file if unset.|
| `NODE_ENV`       | prod            | Set to `production` for strict, secure mode.                   |
| `DARE_TTL_DAYS`  | optional        | Default dare deadline in days (default 14, `0` = none).        |
| `APPEAL_WINDOW_HOURS` | optional   | Window to appeal a rejection (default 48).                     |
| `ALLOW_ORIGIN`   | optional        | Enable cross-origin API access from one origin (default: off). |

Opt-in subsystems — **`LEDGER=1`** (double-entry money), **`SOLANA=1`** and the
`TON_*` block (on-chain deposits) — are documented in `.env.example`. All are off
by default.

---

## Two storage modes

The app can run in either of two modes, and they are not equivalent:

- **JSON blob** (default, no `DATABASE_URL`) — the whole state is one object
  persisted on every write. Simple, fine for a single instance, but it does not
  survive being run with more than one replica: each holds its own copy in memory
  and the last writer wins.
- **Ledger** (`LEDGER=1` + `DATABASE_URL`) — money moves through a double-entry
  journal (`ledger.js`) where every transaction must net to exactly zero and no
  user or escrow balance may go negative. Identity (name, banned, isAdmin) still
  lives in the blob; that split is temporary and is the main piece of debt left.

See `ESCROW_DESIGN.md` and `LEDGER_INTEGRATION.md` for the design.

---

## Deployment (Railway or any Node host)

1. Set `BOT_TOKEN`, `PUBLIC_URL`, `ADMIN_IDS`, `ADMIN_PASSWORD`, `DATABASE_URL`,
   `PGSSL=1`, and **`NODE_ENV=production`** in the host's environment.
2. Deploy. Start command: `npm start`.
3. Point your Telegram Mini App URL (via @BotFather) at the deployed domain.

> In `NODE_ENV=production` the server refuses to boot without a `BOT_TOKEN`, so the
> insecure dev auth bypass can never be exposed live.

### Known operational limits

- **Uploads live on the container filesystem.** On Railway/Docker that is ephemeral,
  so **video proofs are lost on every redeploy** while their rows survive. Mount a
  volume at `UPLOAD_DIR`, or move uploads to object storage, before relying on them.
- **Run one instance.** Dashboard sessions and rate-limit counters are in-memory,
  and in JSON mode so is the entire state.
- **Withdrawals are bookkeeping only.** `POST /api/wallet/withdraw` records the
  ledger side of a send that already settled on-chain; it is admin-only and needs
  the tx hash. Nothing in the app moves real funds yet — `ton.sendUsdt()` and the
  Solana `sweep()` exist but are wired into no route or scheduler, and neither has
  been validated against a live network.

---

## Monitoring

With `LEDGER=1`, `GET /api/admin/health` runs the ledger invariants and answers
**500** when they break:

- `conservation` — every account balance sums to 0 (money is neither created nor destroyed)
- `drift` — cached balances match the append-only journal
- `escrowMatches` — the escrow account equals `SUM(dares.escrow_locked)`
- `liabilitiesUsdt` — what users are owed; the minimum reserve to hold on-chain

Alert on this. If it goes red, stop payouts.

---

## Security notes

- The static file server uses a **strict whitelist**, so the JSON store, `server.js`
  and `.env` can't be fetched over HTTP.
- Dashboard login is **rate-limited** and uses a **timing-safe** password compare;
  writes, proof uploads and the avatar proxy have their own per-user/per-IP budgets.
- Uploaded videos get a **random, unguessable** filename and are streamed with
  byte-range support. They are still served **without authentication** — the URL is
  the only secret.
- Framing is controlled by CSP `frame-ancestors`: the mini app allows Telegram,
  the dashboard allows nobody.
- The JSON store, `.env`, `uploads/` and `node_modules/` are git-ignored.

---

## Project layout

```
server.js        # HTTP layer: routing, auth, JSON-mode state, static serving
server_ledger.js # the same API surface, backed by the ledger (LEDGER=1)
ledger.js        # double-entry primitives: postTx, balances, invariants
wallet.js        # dare/submission content on top of the ledger + read models
deposits.js      # in-flight transfers: seen → confirming → credited
ton.js           # TON deposit polling (+ an unwired withdrawal helper)
solana.js        # per-user Solana USDC deposit addresses, webhook + polling
index.html       # Telegram Mini App (the player-facing UI)
admin.html       # web dashboard (password-protected)
.env.example     # every environment variable, documented
test_*.mjs       # run with `npm test`
```
