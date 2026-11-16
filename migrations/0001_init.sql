-- Fake-money ledger. Every chip movement is a transaction with a unique reference (so retries
-- can never apply it twice) and two entries that sum to zero. Balances can never go negative,
-- except the 'mint' (where test chips come from) and 'bots' (bot bankroll) system accounts.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                      -- 'user:<id>', 'table:<id>', 'house', 'bots', 'mint'
  balance INTEGER NOT NULL DEFAULT 0,
  CHECK (balance >= 0 OR id IN ('mint', 'bots'))
);

CREATE TABLE transactions (
  ref TEXT PRIMARY KEY,                     -- idempotency key, e.g. 'rake:<table>:<hand>'
  kind TEXT NOT NULL,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_ref TEXT NOT NULL REFERENCES transactions(ref),
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE INDEX entries_account ON entries(account_id);

CREATE TABLE hands (
  table_id TEXT NOT NULL,
  hand_no INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  pot INTEGER NOT NULL,
  rake INTEGER NOT NULL,
  players TEXT NOT NULL,                    -- JSON array of user ids dealt in
  PRIMARY KEY (table_id, hand_no)
);

INSERT INTO accounts (id, balance) VALUES ('mint', 0), ('bots', 0), ('house', 0);
