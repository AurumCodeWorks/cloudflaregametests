// Leaving in the middle of a hand: the leaver is folded and released straight away, and the chips they
// already put in the pot stay in it (the ledger must still balance and the table must end at 0).
// Needs the local stack with AUDIT=1 (see README). Run: node tests/leave-midhand.mjs [baseUrl]
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const j = async (path, token, body) => {
  const r = await fetch(B + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return [r.status, await r.json().catch(() => null)];
};
const login = async (name) => (await (await fetch(B + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json()).token;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const join = (token, tableId, onState) => {
  const ws = new WebSocket(`${WSB}/ws/table/${tableId}?token=${token}`);
  const c = { ws, stood: null, closed: null, last: null };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "stood") c.stood = Date.now(); if (m.type === "state") { c.last = m; onState?.(m, c); } };
  ws.onclose = (e) => { c.closed = e.code; };
  return c;
};

const [ta, tb] = [await login("Leaver"), await login("Stayer")];
const [, playA] = await j("/api/play", ta, {});
const [, playB] = await j("/api/play", tb, {});
check(playA.tableId === playB.tableId, "both players were sent to the same table");

// Stayer just checks or calls, so the hand goes on after the leaver goes
const b = join(tb, playB.tableId, (m, c) => { if (m.legal && !m.hand?.result) c.ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" })); });
let leftAt = null, leftHand = null, committed = 0;
const a = join(ta, playA.tableId, (m, c) => {
  if (leftAt || !m.hand || m.hand.result) return;
  const me = m.seats[m.you.seat];
  // Leave once we've put chips in (a blind) and it's someone else's turn
  if (me?.inHand && me.total > 0 && m.hand.toAct !== m.you.seat) {
    leftAt = Date.now(); leftHand = m.hand.no; committed = me.total;
    c.ws.send(JSON.stringify({ type: "leave" }));
  }
});

const deadline = Date.now() + 60_000;
while (!a.stood && Date.now() < deadline) await wait(50);
check(!!leftAt, `left mid-hand #${leftHand} with ${committed} chips already in the pot`);
const took = a.stood ? a.stood - leftAt : Infinity;
// Locally bots act in ~0.15s; live they "think" ~1s each, so allow more there (still far below the 20s turn timer)
check(took < Number(process.env.MAX_RELEASE_MS || 4000), `released in ${(took / 1000).toFixed(1)}s, without waiting out the turn timer`);

// Let that hand finish, then the stayer leaves too and the table goes quiet
while (Date.now() < deadline && !(b.last?.hand?.no > leftHand)) await wait(100);
const seen = b.last;
check(seen?.hand?.no > leftHand, "the hand finished and the next one started without the leaver");
check(!seen?.seats.some((s) => s?.name === "Leaver"), "the leaver's seat was cleared for the next hand");
b.ws.send(JSON.stringify({ type: "leave" }));
while (!b.stood && Date.now() < deadline + 30_000) await wait(100);

// The bots finish any hand in progress, then cash out and the table goes quiet
let ast, audit, table;
for (const until = Date.now() + 20_000; Date.now() < until; await wait(500)) {
  [ast, audit] = await j("/api/audit", tb);
  table = audit?.accounts?.find((x) => x.id === `table:${playA.tableId}`);
  if (ast !== 200 || table?.balance === 0) break;
}
if (ast !== 200) console.log("  (audit endpoint off: skipping ledger checks)");
else {
  check(audit.sum === 0, `ledger sums to 0 (${audit.sum})`);
  check(table?.balance === 0, `nothing left on the table account (${table?.balance}), so the leaver's pot chips were paid out to the winner`);
}
a.ws.close(); b.ws.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL LEAVE CHECKS PASSED");
process.exit(failures ? 1 : 0);
