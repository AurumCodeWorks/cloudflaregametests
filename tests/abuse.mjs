// Tries to break the server the way a cheater would: node tests/abuse.mjs [baseUrl]  (needs the local stack)
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const j = async (path, opts = {}, token) => {
  const r = await fetch(B + path, { ...opts, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return [r.status, await r.json().catch(() => null)];
};
const login = async (name) => (await j("/api/login", { method: "POST", body: JSON.stringify({ name }) }))[1];
const open = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url);
  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  ws.onopen = () => resolve({ ws, msgs, closed: null });
  ws.onerror = () => resolve({ ws, msgs, error: true });
  ws.onclose = (e) => { ws._closed = e.code; };
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(50); } return null; };

// 1. No token, bad token, made-up table
check((await j("/api/me"))[0] === 401, "API without a token is refused");
check((await j("/api/me", {}, "f".repeat(48)))[0] === 401, "API with a forged token is refused");
const anon = await open(`${WSB}/ws/table/t-12345678`);
await wait(300);
check(anon.error || anon.ws.readyState !== 1, "WebSocket without a token is refused");

const a = await login("Mallory");
const [, play] = await j("/api/play", { method: "POST" }, a.token);
check((await j("/api/hands/t-zzzzzzzz/1", {}, a.token))[0] === 404, "malformed table ids are rejected");

// 2. Join a table and wait to be dealt in
const c = await open(`${WSB}/ws/table/${play.tableId}?token=${a.token}`);
const dealt = await until(() => c.msgs.findLast((m) => m.type === "state" && m.you.seat >= 0 && m.hand && !m.hand.result));
check(!!dealt, "player is seated and dealt in");

// 3. Never see other players' cards
const leaked = c.msgs.filter((m) => m.type === "state").some((m) => m.seats.some((s, i) => s && i !== m.you.seat && s.hole.some((x) => x !== "??") && !m.hand?.result?.shown?.[i]));
check(!leaked, "no other player's hole cards are ever sent before showdown");
check(!c.msgs.some((m) => m.type === "state" && m.hand && (m.hand.deck || m.hand.salts)), "the deck and salts are never sent to clients");

// 4. Act out of turn / illegal amounts
const notMyTurn = await until(() => { const m = c.msgs.findLast((x) => x.type === "state"); return m && m.hand && !m.hand.result && m.hand.toAct !== m.you.seat ? m : null; });
if (notMyTurn) {
  const before = c.msgs.length;
  c.ws.send(JSON.stringify({ type: "action", action: "call" }));
  const reply = await until(() => c.msgs.slice(before).find((m) => m.type === "error"), 3000);
  check(reply && /not your turn|not in this hand/i.test(reply.message), `acting out of turn is rejected ("${reply?.message}")`);
}
const myTurn = await until(() => { const m = c.msgs.findLast((x) => x.type === "state"); return m?.legal ? m : null; }, 20000);
if (myTurn) {
  let before = c.msgs.length;
  c.ws.send(JSON.stringify({ type: "action", action: "raise", to: 1 }));
  let reply = await until(() => c.msgs.slice(before).find((m) => m.type === "error"), 3000);
  check(reply && /minimum raise|not allowed/i.test(reply.message), `raise below the minimum is rejected ("${reply?.message}")`);
  before = c.msgs.length;
  c.ws.send(JSON.stringify({ type: "action", action: "raise", to: 999999 }));
  reply = await until(() => c.msgs.slice(before).find((m) => m.type === "error"), 3000);
  check(reply && /not enough chips/i.test(reply.message), `raise above your stack is rejected ("${reply?.message}")`);
  before = c.msgs.length;
  c.ws.send(JSON.stringify({ type: "action", action: "steal-pot" }));
  reply = await until(() => c.msgs.slice(before).find((m) => m.type === "error"), 3000);
  check(!!reply, "unknown actions are rejected");
}

// 5. Flooding the server gets you disconnected
for (let i = 0; i < 60; i++) c.ws.send(JSON.stringify({ type: "ping" }));
const closedCode = await until(() => c.ws._closed, 5000);
check(closedCode === 1008, `message flood closes the connection (code ${closedCode})`);

// 6. Daily chips can't be farmed
check((await j("/api/daily", { method: "POST" }, a.token))[0] === 400, "daily chips refused while balance is healthy");

console.log(failures ? `\n${failures} FAILURES` : "\nALL ABUSE CHECKS PASSED");
process.exit(failures ? 1 : 0);
