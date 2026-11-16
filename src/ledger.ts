// Double-entry ledger on D1. Each transfer runs as one atomic batch:
//   - the unique ref makes retries safe (a repeat is reported as "duplicate", never applied twice)
//   - the CHECK constraint rolls the whole batch back if any balance would go negative

export type TransferResult = "ok" | "duplicate" | "insufficient";

export async function transfer(
  db: D1Database,
  from: string,
  to: string,
  amount: number,
  ref: string,
  kind: string,
): Promise<TransferResult> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Bad transfer amount ${amount}`);
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("INSERT INTO transactions (ref, kind, from_account, to_account, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(ref, kind, from, to, amount, now),
      db.prepare("INSERT INTO accounts (id, balance) VALUES (?, 0), (?, 0) ON CONFLICT(id) DO NOTHING").bind(from, to),
      db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").bind(amount, from),
      db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").bind(amount, to),
      db.prepare("INSERT INTO entries (tx_ref, account_id, amount) VALUES (?, ?, ?), (?, ?, ?)")
        .bind(ref, from, -amount, ref, to, amount),
    ]);
    return "ok";
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("UNIQUE constraint failed") || msg.includes("PRIMARY KEY")) return "duplicate";
    if (msg.includes("CHECK constraint failed")) return "insufficient";
    throw e;
  }
}

export async function balance(db: D1Database, account: string): Promise<number> {
  const row = await db.prepare("SELECT balance FROM accounts WHERE id = ?").bind(account).first<{ balance: number }>();
  return row?.balance ?? 0;
}
