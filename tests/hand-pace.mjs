// Pace between hands: when a human makes the last move of a hand, the next hand must still start after the
// normal pause (NEXT_HAND_MS), not after that player's unused turn timer runs out.
// Needs the dev server with a long turn timer, e.g. --var TURN_SECONDS:20 --var NEXT_HAND_MS:1200
// Run: node tests/hand-pace.mjs [baseUrl] [nextHandMs]
const B = process.argv[2] || "http://localhost:8787";
const NEXT_HAND_MS = Number(process.argv[3] || 1200);
const WSB = B.replace("http", "ws");
const post = async (p, tok, body) => (await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };

// Four people fill the table, so every hand ends on a human's move
const players = [];
for (const n of ["Ivy", "Jun", "Kit", "Lou"]) { const { token } = await post("/api/login", null, { name: n }); players.push({ token, ...(await post("/api/play", token)) }); }
check(new Set(players.map((p) => p.tableId)).size === 1, "all four at one table");
const ended = {}, started = {}, sockets = [];
for (const p of players) {
  const ws = new WebSocket(`${WSB}/ws/table/${p.tableId}?token=${p.token}`);
  sockets.push(ws);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "state" || !m.hand) return;
    if (m.hand.result) ended[m.hand.no] ??= Date.now(); else started[m.hand.no] ??= Date.now();
    if (m.legal && !m.hand.result) ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" }));
  };
}
const until = Date.now() + 60_000;
while (Date.now() < until && !started[4]) await new Promise((r) => setTimeout(r, 100));
const gaps = [1, 2, 3].filter((n) => ended[n] && started[n + 1]).map((n) => started[n + 1] - ended[n]);
check(gaps.length === 3, `three hands played back to back (${gaps.length} gaps measured)`);
check(gaps.every((g) => g < NEXT_HAND_MS + 2500), `next hand deals after the normal pause: ${gaps.map((g) => (g / 1000).toFixed(1) + "s").join(", ")}`);
for (const ws of sockets) { ws.send(JSON.stringify({ type: "leave" })); ws.close(); }
console.log(failures ? `\n${failures} FAILURES` : "\nALL PACE CHECKS PASSED");
process.exit(failures ? 1 : 0);
