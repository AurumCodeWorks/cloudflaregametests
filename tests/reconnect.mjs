// Disconnection recovery: nobody loses their seat or chips to a dropped connection or a server restart.
// Needs the dev server with a short seat hold and the audit hooks:
//   npx wrangler dev --var BOT_DELAY_MS:150 --var NEXT_HAND_MS:1200 --var TURN_SECONDS:6 --var AWAY_SECONDS:12 --var AUDIT:1
// Run: node tests/reconnect.mjs [baseUrl]
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await fn(); if (v) return v; } return null; };
const api = async (path, token, body) => {
  const r = await fetch(B + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json().catch(() => null);
};

/** A scripted player: checks or calls, sends seeds, and (optionally) reconnects by itself like the real client. */
class Player {
  constructor(name) { this.name = name; this.states = []; this.autoReconnect = false; this.reconnects = 0; }
  async login() { this.token = (await api("/api/login", null, { name: this.name })).token; return this; }
  async sit() { this.table = (await api("/api/play", this.token, {})).tableId; this.open(); return this; }
  open() {
    const ws = (this.ws = new WebSocket(`${WSB}/ws/table/${this.table}?token=${this.token}`));
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const m = JSON.parse(e.data);
      if (m.type !== "state") return;
      this.states.push(m);
      if (m.nextCommit) ws.send(JSON.stringify({ type: "seed", commit: m.nextCommit, seed: [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("") }));
      if (m.legal && !m.hand?.result) ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" }));
    };
    ws.onclose = () => { if (this.ws === ws && this.autoReconnect) { this.reconnects++; setTimeout(() => this.ws === ws && this.open(), 300); } };
  }
  drop() { const ws = this.ws; this.ws = null; ws.close(); } // the connection just goes
  get last() { return this.states.at(-1); }
  seatOf(state, name) { return state.seats.findIndex((s) => s?.name === name); }
}
const audit = async (token) => api("/api/audit", token);

// ---------------------------------------------------------------- A. a blip mid-hand
const a = await (await new Player("Ana").login()).sit();
const b = await (await new Player("Ben").login()).sit();
check(a.table === b.table, "both players at the same table");
await until(() => a.last?.hand && !a.last.hand.result && a.last.you.seat >= 0 && b.last?.you.seat >= 0, 20000);
const seatA = a.last.you.seat;
a.drop();
const seen = await until(() => { const s = b.last; return s?.seats[seatA]?.away ? s : null; }, 5000);
check(!!seen, "the others see Ana as away, seat held");
check(seen?.seats[seatA]?.heldForMs > 5000, `with time left on the hold (${Math.round((seen?.seats[seatA]?.heldForMs ?? 0) / 1000)}s)`);
check((await api("/api/me", a.token)).table === a.table, "/api/me still points Ana to her table (so a reload or another device rejoins)");
check((await api("/api/play", a.token, {})).tableId === a.table, "Take a seat sends her back to the same table, not a new one");
a.states = [];
a.open();
const back = await until(() => a.last, 5000);
check(back?.you.seat === seatA, `reconnected into the same seat (${back?.you.seat} = ${seatA})`);
check(back && !back.seats[seatA].away, "no longer marked away");
check(b.last.log.some((l) => /Ana lost connection/.test(l)) && (await until(() => b.last.log.some((l) => l === "Ana is back"), 3000)), "the table log says she dropped and came back");

// ---------------------------------------------------------------- B. away for whole hands: sat out, nothing lost
await until(() => a.last?.hand?.result, 30000);
const stackBefore = a.last.seats[seatA].stack;
const handAtDrop = a.last.hand.no;
a.drop();
const later = await until(() => { const s = b.last; return s?.hand && s.hand.no >= handAtDrop + 2 && s.hand.result ? s : null; }, 40000);
check(!!later, "two more hands were played while Ana was away");
if (!later) { const s = b.last; console.log("  DEBUG at drop: hand", handAtDrop, "| now: hand", s?.hand?.no, "result", !!s?.hand?.result, "| seats", JSON.stringify(s?.seats.map((x) => x && { n: x.name, st: x.stack, inHand: x.inHand, away: x.away }))); console.log("  log:", s?.log.slice(-8).join(" | ")); process.exit(1); }
check(later?.seats[seatA]?.stack === stackBefore, `Ana's stack untouched while away: no blinds, no auto-folds (${later?.seats[seatA]?.stack} = ${stackBefore})`);
check(later && !later.seats[seatA].inHand, "she wasn't dealt in while away");
a.states = [];
a.open();
const dealtBack = await until(() => { const s = a.last; return s?.hand && !s.hand.result && s.hand.no > later.hand.no && s.seats[seatA]?.inHand ? s : null; }, 20000);
check(!!dealtBack, "dealt back in at the next hand after reconnecting");

// ---------------------------------------------------------------- C. gone longer than the hold: chips go back to the balance
await until(() => a.last?.hand?.result, 30000);
const stackAtLeave = a.last.seats[seatA].stack;
const balBefore = (await api("/api/me", a.token)).balance;
a.drop();
const released = await until(async () => { const s = b.last; return s && !s.seats.some((x) => x?.name === "Ana") ? s : null; }, 40000);
check(!!released, "after the hold ran out, Ana's seat was released");
const meAfter = await api("/api/me", a.token);
check(meAfter.table === null, "/api/me no longer points her to the table");
check(meAfter.balance === balBefore + stackAtLeave, `her ${stackAtLeave} chips went back to her balance (${balBefore} -> ${meAfter.balance})`);

// ---------------------------------------------------------------- D. the server restarts between moving chips and saving the table
const c = await (await new Player("Cleo").login());
for (const p of [b]) p.autoReconnect = true;
await api(`/api/debug/crash/${b.table}`, b.token, { kind: "demo-buyin" }); // crash right after the next buy-in transfer
c.autoReconnect = true;
await c.sit();
check(c.table === b.table, "Cleo joins the same table");
const recovered = await until(() => { const s = c.last; return s && s.you.seat >= 0 && s.seats[s.you.seat].stack > 0 && s.log.some((l) => /Restart recovery/.test(l)) ? s : null; }, 30000);
check(b.reconnects + c.reconnects > 0, `the table really restarted (connections dropped and came back: ${b.reconnects + c.reconnects})`);
check(!!recovered, "after the restart the unfinished buy-in was completed and Cleo is seated with her chips");
check(recovered?.log.some((l) => /Restart recovery: finished 1 chip movement/.test(l)), "the log records the recovery");
// The books: the table's ledger account holds exactly the chips on the table (between hands)
const between = await until(() => { const s = c.last; return s?.hand?.result ? s : null; }, 30000);
const onTable = between.seats.reduce((t, s) => t + (s ? s.stack : 0), 0);
const acct = (await audit(c.token)).accounts.find((x) => x.id === `table:${c.table}`);
check(acct?.balance === onTable, `table account ${acct?.balance} = chips at the table ${onTable}: nothing stranded`);
check((await audit(c.token)).sum === 0, "the whole ledger still balances to 0");

for (const p of [b, c]) { p.autoReconnect = false; p.ws?.send(JSON.stringify({ type: "leave" })); }
await wait(500);
for (const p of [b, c]) p.ws?.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL RECONNECT CHECKS PASSED");
process.exit(failures ? 1 : 0);
