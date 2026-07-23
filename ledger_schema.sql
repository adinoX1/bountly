-- ============================================================
-- BOUNTLY — escrow / double-entry ledger schema (Postgres)
--
-- Money is NEVER a floating-point number and NEVER lives in one
-- place that can be edited freely. Every movement is a balanced
-- double-entry transaction: the sum of all entry amounts in one
-- transaction is ALWAYS exactly 0. Money cannot be created or
-- destroyed inside the system — only moved between accounts.
--
-- Amounts are integer micro-units (1 USDT = 1_000_000). No floats.
-- ============================================================

-- ---- accounts ------------------------------------------------
-- kind:
--   user           -> a player's spendable balance (a liability we owe them)
--   escrow         -> funds locked behind open dares (a liability)
--   platform_fees  -> our revenue
--   external       -> the outside world (chain). A contra account:
--                     deposits flow external -> user, withdrawals user -> external.
--                     Its balance mirrors the negative of everything inside.
CREATE TABLE IF NOT EXISTS accounts (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('user','escrow','platform_fees','external')),
  owner_id    TEXT NOT NULL DEFAULT '',          -- telegram user id for kind='user', '' otherwise
  currency    TEXT NOT NULL DEFAULT 'USDT',
  balance     BIGINT NOT NULL DEFAULT 0,         -- cached = SUM(ledger_entries.amount)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, owner_id, currency)
);

-- ---- a transaction groups 2+ entries that must net to zero ----
CREATE TABLE IF NOT EXISTS ledger_tx (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,                     -- deposit | fund_dare | payout | refund | withdraw
  ref         TEXT,                              -- dare code, on-chain tx hash, etc.
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- the immutable, append-only journal ----------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       BIGINT NOT NULL REFERENCES ledger_tx(id),
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  amount      BIGINT NOT NULL,                   -- signed: +credit, -debit (micro-units)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_tx      ON ledger_entries(tx_id);

-- ---- dares (only the money-relevant fields) ------------------
-- escrow_locked = funds still held for UNPAID winner slots of this dare.
-- It only ever goes down (a payout) or is refunded to 0 (cancel/expire).
CREATE TABLE IF NOT EXISTS dares (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  creator_id    TEXT NOT NULL,
  reward        BIGINT NOT NULL CHECK (reward > 0),      -- per winner, micro-units
  max_winners   INT    NOT NULL CHECK (max_winners >= 1),
  fee_bps       INT    NOT NULL DEFAULT 500,             -- creator fee, basis points (500 = 5%)
  status        TEXT   NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  escrow_locked BIGINT NOT NULL CHECK (escrow_locked >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS submissions (
  id          BIGSERIAL PRIMARY KEY,
  dare_id     BIGINT NOT NULL REFERENCES dares(id),
  hunter_id   TEXT NOT NULL,
  vhash       TEXT,                                       -- sha256 of the video (anti-replay)
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- a hunter can only have one LIVE (non-rejected) submission per dare.
-- Partial on purpose: after a rejection they must be able to try again.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_submission
  ON submissions(dare_id, hunter_id) WHERE status <> 'rejected';
-- the same exact clip can never be reused while it counts
CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_vhash
  ON submissions(vhash) WHERE status <> 'rejected' AND vhash IS NOT NULL;
