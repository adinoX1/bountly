# ⚡ Bountly

A **Telegram Mini App** where people post *dares* (challenges) with a credit reward,
and others complete them by submitting a short video proof. An admin (or the web
dashboard) reviews each proof and pays out the bounty. Everything runs on **credits**,
not real money.

> Stack: a single dependency-light **Node.js** HTTP server (`server.js`), a Telegram
> Mini App frontend (`index.html`), and a password-protected web dashboard
> (`admin.html`). State lives in **Postgres** when `DATABASE_URL` is set, otherwise a
> local `data.json` file.

---

## How it works

- **Post a dare** — costs `reward × winners` credits in escrow + a 5% creator fee.
- **Submit a proof** — upload a video (max 50 MB). Each clip is fingerprinted (SHA-256)
  so the same video can't be reused.
- **Review** — admins approve/reject from inside the app or the web dashboard.
  On approval the fastest valid hunters win; payout is the reward minus a 10% player fee.
- **Leaderboard, profiles, transaction ledger** are all derived from the same state.

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

Syntax check before committing:

```bash
npm run check
```

---

## Configuration

All configuration is via environment variables — see **`.env.example`** for the full,
documented list. The important ones:

| Variable         | Required        | Purpose                                                        |
|------------------|-----------------|----------------------------------------------------------------|
| `BOT_TOKEN`      | yes (prod)      | Telegram bot token; enables real `initData` auth.              |
| `ADMIN_IDS`      | recommended     | Comma-separated Telegram IDs that get in-app admin powers.     |
| `ADMIN_PASSWORD` | for dashboard   | Password for the `/admin` web dashboard. Empty = disabled.     |
| `DATABASE_URL`   | for persistence | Postgres connection string. Falls back to `data.json` if unset.|
| `NODE_ENV`       | prod            | Set to `production` for strict, secure mode.                   |
| `ALLOW_ORIGIN`   | optional        | Enable cross-origin API access from one origin (default: off). |

---

## Deployment (Railway or any Node host)

1. Set `BOT_TOKEN`, `ADMIN_IDS`, `ADMIN_PASSWORD`, `DATABASE_URL`, `PGSSL=1`,
   and **`NODE_ENV=production`** in the host's environment.
2. Deploy. Start command: `npm start`.
3. Point your Telegram Mini App URL (via @BotFather) at the deployed domain.

> In `NODE_ENV=production` the server refuses to boot without a `BOT_TOKEN`, so the
> insecure dev auth bypass can never be exposed live.

---

## Security notes

This version (v2.1) hardens several issues — see **`IMPROVEMENTS.md`** for details.
Highlights:

- The static file server uses a **strict whitelist**, so `data.json` (the entire
  database!), `server.js` and `.env` can no longer be fetched over HTTP.
- Dashboard login is **rate-limited** and uses a **timing-safe** password compare.
- Uploaded videos get a **random, unguessable** filename.
- `data.json`, `.env`, `uploads/` and `node_modules/` are **git-ignored** — make sure
  they were never committed (see IMPROVEMENTS.md if they were).

---

## Project layout

```
server.js        # the whole backend: API, auth, storage, static serving
index.html       # Telegram Mini App (the player-facing UI)
admin.html       # web dashboard (password-protected)
data.json        # local state (git-ignored; Postgres used in prod)
.env.example     # documented environment variables
```
