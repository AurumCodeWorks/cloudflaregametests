// Player-seeded shuffle, end to end: your seed is mixed in, can't be swapped, and the deal verifies.
// Needs the dev server. Run: node tests/seeds.mjs [baseUrl]
import { verifyDeal } from "../public/fair.js";
const B = process.argv[2] || "http://localhost:8787";
const WSB = B.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const post = async (p, tok) => (await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: p === "/api/login" ? JSON.stringify({ name: "Seeder" }) : "{}" })).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");

const { token } = await post("/api/login");
const { tableId } = await post("/api/play", token);
const ws = new WebSocket(`${WSB}/ws/table/${tableId}?token=${token}`);
const states = [];
const mine = {}; // commit -> {seed, swap}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type !== "state") return;
  states.push(m);
  if (m.nextCommit && !mine[m.nextCommit]) {
    const seed = hex(16), swap = hex(16);
    mine[m.nextCommit] = { seed, swap };
    ws.send(JSON.stringify({ type: "seed", commit: m.nextCommit, seed }));
    ws.send(JSON.stringify({ type: "seed", commit: m.nextCommit, seed: swap })); // a second seed must not replace the first
    ws.send(JSON.stringify({ type: "seed", commit: "f".repeat(64), seed: hex(16) })); // wrong deck
    ws.send(JSON.stringify({ type: "seed", commit: m.nextCommit, seed: "not-hex" })); // malformed
  }
  if (m.legal && !m.hand?.result) ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" }));
};
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = fn(); if (v) return v; } return null; };

const live = await until(() => states.find((m) => m.hand && !m.hand.result && mine[m.hand.commit]), 20000);
check(!!live, "a hand was dealt from a deck whose fingerprint was published before the deal");
const plan = live && mine[live.hand.commit];
check(live?.hand.seeds.includes(plan.seed), "my seed was mixed into the shuffle");
check(live && !live.hand.seeds.includes(plan.swap), "a second seed for the same deck was ignored (no swapping after the fact)");
check(live && live.hand.seeds.length === 1, `only valid seeds from people at the table were used (${live?.hand.seeds.length})`);
check(live?.log.some((l) => /1 player seed mixed in/.test(l)), "the table log says how many seeds were mixed in");

const done = await until(() => states.find((m) => m.hand?.no === live.hand.no && m.hand.result && m.hand.reveal), 60000);
check(!!done, "the hand finished and sent its proof");
if (done) {
  const h = done.hand, seat = done.you.seat;
  const holes = { [seat]: done.seats[seat].hole };
  for (const [i, sh] of Object.entries(h.result.shown)) holes[i] = sh.hole;
  const input = { commit: live.hand.commit, reveal: h.reveal, seeds: h.seeds, button: h.button, dealtIn: done.seats.map((x) => !!x?.inHand), board: h.board, holes };
  check(await verifyDeal(input), "the deal verifies against the published fingerprint and the seeds");
  check(!(await verifyDeal({ ...input, seeds: [] })), "the same proof fails if the seeds are left out (they really changed the deal)");
}
ws.send(JSON.stringify({ type: "leave" }));
await wait(300); ws.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL SEED CHECKS PASSED");
process.exit(failures ? 1 : 0);
