-- Cosmetics shop: what each player owns, what they have equipped, and every purchase.
CREATE TABLE inventory (
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,                     -- e.g. 'deck:noir' (free items are implied, never stored)
  source TEXT NOT NULL,                      -- 'test-purchase' now; 'purchase' once real payments are on
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE equipped (
  user_id TEXT NOT NULL REFERENCES users(id),
  slot TEXT NOT NULL CHECK (slot IN ('deck', 'room', 'chips', 'celebration')),
  item_id TEXT NOT NULL,
  PRIMARY KEY (user_id, slot)
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,                     -- the item or bundle bought
  price_pence INTEGER NOT NULL,
  mode TEXT NOT NULL,                        -- 'test' (no money taken) or a payment provider name
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX purchases_user ON purchases(user_id);
