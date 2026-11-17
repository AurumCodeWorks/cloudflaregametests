// Cosmetics shop. Items are purely visual and sold directly (no random packs).
// PAYMENTS_MODE "test": purchases complete instantly with no payment taken, clearly labelled.
// A real payment provider plugs in later by calling grantPurchase() from its confirmed-payment webhook.
import { CATALOG, FREE_ITEMS, unlocks } from "./catalog.ts";

export const SLOTS = ["deck", "room", "chips", "celebration"] as const;
export type Slot = (typeof SLOTS)[number];
export const DEFAULT_EQUIPPED: Record<Slot, string> = {
  deck: "deck:modern",
  room: "room:classic",
  chips: "chips:casino",
  celebration: "celebration:glow",
};
const value = (itemId: string) => itemId.split(":")[1];

export async function ownedItems(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT item_id FROM inventory WHERE user_id = ?").bind(userId).all<{ item_id: string }>();
  return new Set([...FREE_ITEMS, ...results.map((r) => r.item_id)]);
}

export async function equippedItems(db: D1Database, userId: string): Promise<Record<Slot, string>> {
  const { results } = await db.prepare("SELECT slot, item_id FROM equipped WHERE user_id = ?").bind(userId).all<{ slot: Slot; item_id: string }>();
  const out = { ...DEFAULT_EQUIPPED };
  for (const r of results) out[r.slot] = r.item_id;
  return out;
}

export async function shopState(db: D1Database, userId: string, mode: string) {
  const [owned, equipped] = await Promise.all([ownedItems(db, userId), equippedItems(db, userId)]);
  return { mode, catalog: CATALOG, owned: [...owned], equipped };
}

type Result = { ok: true; granted: string[] } | { ok: false; status: number; error: string };

/** Record a completed purchase and grant its items. Idempotent per purchase id. Pass `owned` if already loaded. */
export async function grantPurchase(
  db: D1Database, userId: string, itemId: string, purchaseId: string, mode: string, owned?: Set<string>,
): Promise<Result> {
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item) return { ok: false, status: 404, error: "No such item." };
  owned ??= await ownedItems(db, userId);
  const grants = unlocks(itemId).filter((id) => !owned.has(id));
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO purchases (id, user_id, item_id, price_pence, mode, status, created_at) VALUES (?, ?, ?, ?, ?, 'completed', ?)")
      .bind(purchaseId, userId, itemId, item.pricePence, mode, now),
    ...grants.map((g) =>
      db.prepare("INSERT OR IGNORE INTO inventory (user_id, item_id, source, acquired_at) VALUES (?, ?, ?, ?)")
        .bind(userId, g, mode === "test" ? "test-purchase" : "purchase", now),
    ),
  ]);
  return { ok: true, granted: grants };
}

export async function buy(db: D1Database, userId: string, itemId: string, mode: string): Promise<Result> {
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item) return { ok: false, status: 404, error: "No such item." };
  if (item.pricePence === 0) return { ok: false, status: 400, error: "That one's free, it's already yours." };
  const owned = await ownedItems(db, userId);
  if (unlocks(itemId).every((id) => owned.has(id))) return { ok: false, status: 409, error: "You already own everything in that." };
  if (mode !== "test") return { ok: false, status: 501, error: "Payments aren't switched on yet." };
  return grantPurchase(db, userId, itemId, `test:${crypto.randomUUID()}`, "test", owned);
}

export async function equip(db: D1Database, userId: string, itemId: string): Promise<Result> {
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item || item.type === "bundle") return { ok: false, status: 400, error: "That can't be equipped." };
  if (!(await ownedItems(db, userId)).has(itemId)) return { ok: false, status: 403, error: "You don't own that yet." };
  await db.prepare("INSERT INTO equipped (user_id, slot, item_id) VALUES (?, ?, ?) ON CONFLICT(user_id, slot) DO UPDATE SET item_id = excluded.item_id")
    .bind(userId, item.type, itemId).run();
  return { ok: true, granted: [] };
}

/** What other players see of you at the table: your card backs and your win celebration. */
export async function tableCosmetics(db: D1Database, userId: string) {
  const e = await equippedItems(db, userId);
  return { deck: value(e.deck), celebration: value(e.celebration) };
}
