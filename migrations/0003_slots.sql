-- Slot machines. Chips still move only through the ledger (accounts/transactions/entries): each spin's
-- stake goes user -> 'slots' and each payout 'slots' -> user, with refs 'slot:<user>:<seed>:<nonce>:stake|payout'.
-- These tables are the audit trail that lets every spin be re-verified.
CREATE TABLE slot_spins (
  user_id TEXT NOT NULL REFERENCES users(id),
  seed_no INTEGER NOT NULL,                  -- which of the player's server seeds was in use
  nonce INTEGER NOT NULL,                    -- 1, 2, 3... within that seed
  machine TEXT NOT NULL,
  stake INTEGER NOT NULL,
  stops TEXT NOT NULL,                       -- JSON array: the stop of each reel
  payout INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, seed_no, nonce)
);

-- Server seeds are stored here only once revealed (the seed in use lives in the player's Durable Object).
CREATE TABLE slot_seeds (
  user_id TEXT NOT NULL REFERENCES users(id),
  seed_no INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,                 -- sha256(server_seed), published before any spin used it
  client_seed TEXT NOT NULL,
  server_seed TEXT NOT NULL,
  spins INTEGER NOT NULL,
  revealed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, seed_no)
);

INSERT INTO accounts (id, balance) VALUES ('slots', 0);
