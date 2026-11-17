// Between hands: countdown to the next deal, Top up, and Continue (everyone ready = deal now).
// Needs the dev server with the normal pause: npx wrangler dev --var BOT_DELAY_MS:150 --var TURN_SECONDS:6 --var AUDIT:1
// Run: node tests/between-hands.mjs [baseUrl] [nextHandMs]
const B = process.argv[2] || "http://localhost:8787";
const NEXT_HAND_MS = Number(process.argv[3] || 5500);
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const post = async (p, tok, body) => (await fetch(B + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body && JSON.stringify(body) })).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await post("/api/login", null, { name: "Waiter" });
const { tableId } = await post("/api/play", token, {});
const ws = new WebSocket(`${WSB}/ws/table/${tableId}?token=${token}`);
const states = [], errors = [];
let midHandTried = false;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "error") errors.push(m.message);
  if (m.type !== "state") return;
  m.at = Date.now();
  states.push(m);
  if (m.legal && !m.hand?.result) {
    if (!midHandTried) { midHandTried = true; ws.send(JSON.stringify({ type: "topup" })); } // must be refused mid-hand
    ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" }));
  }
};
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = fn(); if (v) return v; } return null; };
const between = () => states.findLast((m) => m.hand?.result && m.next && m.you.seat >= 0);

// 1. The countdown matches the real pause
const first = await until(between, 60_000);
check(!!first, "a hand finished and the table reports a countdown");
check(first && first.next.inMs > 0 && first.next.inMs <= NEXT_HAND_MS && first.next.totalMs === NEXT_HAND_MS, `countdown starts from the real pause (${first?.next.inMs} of ${first?.next.totalMs} ms)`);
await until(() => midHandTried && errors.length, 5000);
check(errors.some((e) => /between hands/.test(e)), "topping up mid-hand is refused");

// 2. Top up (wait for a hand that leaves us under the maximum)
let topped = false;
for (const end = Date.now() + 90_000; !topped && Date.now() < end;) {
  const b = await until(() => { const s = between(); return s && s.you.topUp > 0 && s.seats[s.you.seat].stack < 500 ? s : null; }, 30_000);
  if (!b) continue;
  const n = states.length;
  ws.send(JSON.stringify({ type: "topup" }));
  const after = await until(() => states.slice(n).find((m) => m.seats[m.you.seat]?.stack === 500 && m.you.topUp === 0), 3000);
  check(!!after, `top up from ${b.seats[b.you.seat].stack} to 500 between hands`);
  check(after?.log.some((l) => l === "Waiter tops up to 500"), "the table log shows the top-up");
  topped = true;
}
check(topped, "got a chance to top up");

// 3. Continue: the only person at the table is ready, so the next hand deals almost at once
const b2 = await until(() => { const s = between(); return s && s.next.inMs > 2500 ? s : null; }, 60_000);
const sentAt = Date.now();
ws.send(JSON.stringify({ type: "ready" }));
const dealt = await until(() => states.find((m) => m.at > sentAt && m.hand && !m.hand.result && m.hand.no > b2.hand.no), 5000);
const took = dealt ? dealt.at - sentAt : Infinity;
check(took < 1500, `Continue dealt the next hand in ${(took / 1000).toFixed(1)}s instead of waiting ${(b2.next.inMs / 1000).toFixed(1)}s`);
check(!dealt?.you.ready, "Continue resets for the next hand");

// 4. Leave; the books still balance
ws.send(JSON.stringify({ type: "leave" }));
let audit;
for (const end = Date.now() + 20_000; Date.now() < end; await wait(500)) {
  audit = await post("/api/audit", token).catch(() => null);
  if (!audit?.accounts || audit.accounts.find((a) => a.id === `table:${tableId}`)?.balance === 0) break;
}
if (audit?.accounts) check(audit.sum === 0 && audit.accounts.find((a) => a.id === `table:${tableId}`)?.balance === 0, `ledger balances with top-ups (sum ${audit.sum})`);
ws.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL BETWEEN-HANDS CHECKS PASSED");
process.exit(failures ? 1 : 0);
