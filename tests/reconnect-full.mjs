// A full table where everyone else has dropped: the last active player must not be stuck. Seats held for
// disconnected players can't take bots, so the table waits for the holds to run out, then deals again.
// Needs the dev server with a short hold (--var AWAY_SECONDS:12). Run: node tests/reconnect-full.mjs [baseUrl]
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(100)) { const v = fn(); if (v) return v; } return null; };
const post = async (path, token, body) => (await fetch(B + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();

async function player(name) {
  const { token } = await post("/api/login", null, { name });
  const { tableId } = await post("/api/play", token);
  const p = { name, token, table: tableId, states: [] };
  p.ws = new WebSocket(`${WSB}/ws/table/${tableId}?token=${token}`);
  p.ws.onmessage = (e) => {
    if (e.data === "pong") return;
    const m = JSON.parse(e.data);
    if (m.type !== "state") return;
    p.states.push(m);
    if (m.legal && !m.hand?.result) p.ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" }));
  };
  await until(() => p.states.at(-1)?.you.seat >= 0, 15000);
  return p;
}

const ps = [];
for (const n of ["Fae", "Gus", "Hal", "Ivo"]) ps.push(await player(n));
check(new Set(ps.map((p) => p.table)).size === 1, "four people fill one table (no bots)");
const last = ps[3];
await until(() => last.states.at(-1)?.hand && !last.states.at(-1).hand.result, 15000);
for (const p of ps.slice(0, 3)) p.ws.close(); // three of them vanish
const dropAt = Date.now();
// While their seats are held, Ivo has nobody to play; once the holds run out, bots take the seats and play resumes
const resumed = await until(() => {
  const s = last.states.at(-1);
  return s?.hand && !s.hand.result && Date.now() - dropAt > 12000 && s.seats.filter((x) => x?.isBot).length >= 1 && s.seats.some((x, i) => x?.isBot && x.inHand) ? s : null;
}, 45000);
check(!!resumed, `play resumed with bots ${resumed ? Math.round((Date.now() - dropAt) / 1000) + "s" : "never"} after the others dropped (holds are 12s)`);
check(resumed && !resumed.seats.some((x) => ["Fae", "Gus", "Hal"].includes(x?.name)), "the seats held for the three who left were released");
last.ws.send(JSON.stringify({ type: "leave" }));
await wait(300);
last.ws.close();

// A table where everyone has dropped (seats held, nobody playing) must not swallow newcomers
await wait(61000); // sign-up rate limit
const g1 = await player("Jo"), g2 = await player("Kai");
check(g1.table === g2.table, "two people at one table");
g1.ws.close(); g2.ws.close(); // both drop: their seats are held, nobody is playing there
await wait(3000);
const newcomer = await player("Lux");
check(newcomer.table !== g1.table, `quick seat puts a newcomer at a table with people actually playing, not one of held seats (${newcomer.table} vs ${g1.table})`);
const dealt = await until(() => { const s = newcomer.states.at(-1); return s?.hand && !s.hand.result && s.seats[s.you.seat]?.inHand ? s : null; }, 15000);
check(!!dealt, "and the newcomer is dealt in straight away");
newcomer.ws.send(JSON.stringify({ type: "leave" }));
await wait(300);
newcomer.ws.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL FULL-TABLE CHECKS PASSED");
process.exit(failures ? 1 : 0);
