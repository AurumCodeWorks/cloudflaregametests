// Demo mode (UNLIMITED=1): chips never run out and every shop item unlocks free.
// Needs the local stack (see README). Run: node tests/unlimited.mjs [baseUrl]
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const j = async (path, token, body) => {
  const r = await fetch(B + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return [r.status, await r.json().catch(() => null)];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ balance and shop
const [, login] = await j("/api/login", null, { name: "Shover" });
const T = login.token;
const [, me] = await j("/api/me", T);
check(me.unlimited === true && me.balance >= 1_000_000, `balance is topped up and flagged unlimited (${me.balance.toLocaleString()})`);
check((await j("/api/daily", T, {}))[0] === 400, "daily chips aren't needed (and can't be farmed) in the demo");

let [st, shop] = await j("/api/shop", T);
check(st === 200 && shop.unlimited === true, "shop knows it's the demo");
[st, shop] = await j("/api/shop/buy", T, { itemId: "bundle:everything" });
const all = shop.catalog.filter((i) => i.type !== "bundle").map((i) => i.id);
check(st === 200 && all.every((id) => shop.owned.includes(id)), `"Everything" unlocks all ${all.length} items free`);
check((await j("/api/shop/equip", T, { itemId: "deck:noir" }))[0] === 200, "any unlocked item can be equipped");

// ------------------------------------------------------------------ bust and re-buy
// Shove every hand until the stack hits zero; the table must re-buy instead of sending us to the lobby.
const [, play] = await j("/api/play", T, {});
const ws = new WebSocket(`${WSB}/ws/table/${play.tableId}?token=${T}`);
let latest = null, stood = false, closed = null, busted = false, rebought = false, shoves = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "stood") stood = true;
  if (m.type !== "state") return;
  latest = m;
  const me = m.seats[m.you.seat];
  if (m.hand?.result && me && me.stack === 0) busted = true;
  if (busted && me && me.stack > 0 && m.log.some((l) => l.startsWith("Shover re-buys"))) rebought = true;
  if (m.legal && !m.hand?.result) { ws.send(JSON.stringify({ type: "action", action: "allin" })); shoves++; }
};
ws.onclose = (e) => { closed = e.code; };
const started = Date.now();
const deadline = Date.now() + Number(process.env.TIMEOUT_MS || 240_000);
while (!rebought && closed === null && Date.now() < deadline) await wait(100);
console.log(`  (${shoves} shoves, last hand #${latest?.hand?.no ?? "?"}, stack ${latest?.seats?.[latest.you.seat]?.stack ?? "-"}, stood ${stood}, socket close code ${closed ?? "open"}, ${Math.round((Date.now() - started) / 1000)}s)`);
check(busted, "went broke at the table");
check(rebought, "re-bought automatically after busting");
check(!stood && closed === null, "stayed seated instead of being sent back to the lobby");
const [, after] = await j("/api/me", T);
check(after.balance >= 1_000_000, `balance tops back up afterwards (${after.balance.toLocaleString()})`);
ws.send(JSON.stringify({ type: "leave" }));
await wait(500);
ws.close();

const [ast, audit] = await j("/api/audit", T);
if (ast === 200) check(audit.sum === 0, `ledger still balances to 0 with demo top-ups (sum ${audit.sum})`);

console.log(failures ? `\n${failures} FAILURES` : "\nALL UNLIMITED CHECKS PASSED");
process.exit(failures ? 1 : 0);
