// Run with: node tests/engine.test.ts   (Node 22.18+ runs TypeScript directly)
import assert from "node:assert/strict";
import { bestScore, bestScoreReference, categoryName, commitDeck, eval5, freshDeck, randomHex, secureShuffle, verifyReveal } from "../src/cards.ts";
import {
  act, buildPots, chipsOnTable, historyOf, legalActions, newSeat, newTable, replayHand, revealFor, startHand, BIG_BLIND, BUY_IN,
} from "../src/holdem.ts";
import type { TableState } from "../src/holdem.ts";
import { botView, decide, handClass } from "../src/bot.ts";
import { PREFLOP_EQUITY } from "../src/preflop.ts";
import { STAKES, TOURNAMENT_RAKE, disclose } from "../src/stakes.ts";
import { newSeed, permutationFrom, verifyDeal } from "../public/fair.js";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => { passed++; console.log(`ok - ${name}`); });
}

await test("hand rankings order correctly", () => {
  const hands = [
    ["As", "Ks", "Qs", "Js", "Ts"], // straight flush
    ["9c", "9d", "9h", "9s", "2c"], // quads
    ["8c", "8d", "8h", "4s", "4c"], // full house
    ["Ah", "Jh", "8h", "6h", "2h"], // flush
    ["6c", "5d", "4h", "3s", "2c"], // 6-high straight
    ["5c", "4d", "3h", "2s", "Ac"], // wheel (5-high straight)
    ["7c", "7d", "7h", "Ks", "2c"], // trips
    ["Jc", "Jd", "4h", "4s", "Ac"], // two pair
    ["Tc", "Td", "Ah", "8s", "3c"], // pair
    ["Ac", "Qd", "9h", "6s", "3c"], // high card
  ];
  const scores = hands.map(eval5);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] > scores[i], `${hands[i - 1]} should beat ${hands[i]}`);
  assert.equal(categoryName(scores[0]), "Straight flush");
  assert.equal(categoryName(scores[5]), "Straight");
});

await test("kickers decide ties correctly", () => {
  assert.ok(eval5(["Ac", "Ad", "Kh", "8s", "3c"]) > eval5(["As", "Ah", "Qh", "8d", "3d"]));
  assert.equal(eval5(["Ac", "Ad", "Kh", "8s", "3c"]), eval5(["As", "Ah", "Kd", "8d", "3d"]));
  assert.ok(eval5(["Kc", "Kd", "2h", "2s", "Ac"]) > eval5(["Qc", "Qd", "Jh", "Js", "Ac"]));
});

await test("best 5 of 7 is found", () => {
  assert.equal(categoryName(bestScore(["2c", "3c", "4c", "5c", "9d", "6c", "Kh"])), "Straight flush");
  assert.equal(categoryName(bestScore(["Ah", "Ad", "Ac", "Kd", "Ks", "2c", "3h"])), "Full house");
});

await test("shuffle is a permutation; partial reveal verifies; tampering is detected", async () => {
  const d = secureShuffle(freshDeck());
  assert.equal(new Set(d).size, 52);
  const salts = d.map(() => randomHex(8));
  const { commit, leaves } = await commitDeck(d, salts);
  // reveal only the first 7 positions, hide the rest
  const reveal = d.map((card, i) => (i < 7 ? { card, salt: salts[i] } : { leaf: leaves[i] }));
  assert.ok(await verifyReveal(commit, reveal));
  const swapped = reveal.slice();
  swapped[0] = { card: d[8], salt: salts[0] }; // claim a different card was at position 0
  assert.ok(!(await verifyReveal(commit, swapped)));
});

await test("side pots: short all-in wins main pot, bigger stacks contest the side pot", () => {
  const t = newTable();
  t.seats[0] = newSeat("a", "A", false, 100, "r");
  t.seats[1] = newSeat("b", "B", false, 300, "r");
  t.seats[2] = newSeat("c", "C", false, 300, "r");
  // deal order with button 0: seats 1,2,0,1,2,0 | burn | flop | burn | turn | burn | river
  const top = ["Ks", "Qs", "As", "Kh", "Qh", "Ah", "8d", "2c", "7d", "9s", "8c", "3h", "8h", "4c"];
  const deck = top.concat(freshDeck().filter((c) => !top.includes(c)));
  assert.ok(startHand(t, deck, [], "commit"));
  assert.equal(t.hand!.button, 0);
  assert.equal(t.hand!.toAct, 0);
  assert.equal(act(t, 0, { type: "allin" }), null);
  assert.equal(act(t, 1, { type: "allin" }), null);
  assert.equal(act(t, 2, { type: "call" }), null);
  const r = t.hand!.result!;
  assert.equal(r.endedBy, "showdown");
  assert.equal(r.rake, 30); // 5% of 700 = 35, capped at 30
  assert.deepEqual(r.pots.map((p) => [p.amount, p.winners]), [[300, [0]], [400, [1]]]);
  assert.deepEqual([t.seats[0]!.stack, t.seats[1]!.stack, t.seats[2]!.stack], [270, 400, 0]);
});

await test("illegal actions are rejected", () => {
  const t = newTable();
  t.seats[0] = newSeat("a", "A", false, 500, "r");
  t.seats[1] = newSeat("b", "B", false, 500, "r");
  startHand(t, secureShuffle(freshDeck()), [], "c");
  const actor = t.hand!.toAct;
  const other = actor === 0 ? 1 : 0;
  assert.equal(act(t, other, { type: "call" }), "Not your turn");
  assert.match(act(t, actor, { type: "check" })!, /Cannot check/);
  assert.match(act(t, actor, { type: "raise", to: 12 })!, /Minimum raise/);
  assert.equal(act(t, actor, { type: "raise", to: 9999 }), "Not enough chips");
  assert.equal(act(t, actor, { type: "raise", to: 20.5 }), "Raise amount must be a whole number");
});

await test("no flop, no rake: preflop fold takes nothing", () => {
  const t = newTable();
  t.seats[0] = newSeat("a", "A", false, 500, "r");
  t.seats[1] = newSeat("b", "B", false, 500, "r");
  startHand(t, secureShuffle(freshDeck()), [], "c");
  act(t, t.hand!.toAct, { type: "fold" });
  assert.equal(t.hand!.result!.rake, 0);
  assert.equal(t.seats[0]!.stack + t.seats[1]!.stack, 1000);
});

await test("house cut follows the table's stake rule; tournaments take none; cards unaffected", () => {
  const run = (rake?: { percent: number; cap: number; noFlopNoDrop: boolean }) => {
    const t = newTable();
    if (rake) t.rake = rake;
    t.seats[0] = newSeat("a", "A", false, 500, "r");
    t.seats[1] = newSeat("b", "B", false, 500, "r");
    const deck = freshDeck(); // same fixed deck for every run: rake rules must never change the cards
    startHand(t, deck, [], "c");
    act(t, t.hand!.toAct, { type: "allin" });
    act(t, t.hand!.toAct, { type: "call" });
    return { rake: t.hand!.result!.rake, board: t.hand!.board.join(), stacks: t.seats.map((s) => s?.stack) };
  };
  const base = run();
  assert.equal(base.rake, 30); // default: 5% of 1000 = 50, capped at 30
  assert.equal(run({ percent: 5, cap: 1000, noFlopNoDrop: true }).rake, 50);
  assert.equal(run(TOURNAMENT_RAKE).rake, 0);
  assert.equal(run(TOURNAMENT_RAKE).board, base.board);
  for (const tier of STAKES) {
    assert.ok(tier.sitAndGo.feePence / tier.sitAndGo.buyInPence <= 0.1, `${tier.id} fee above 10%`);
    assert.equal(tier.sitAndGo.payouts.reduce((a, b) => a + b, 0), 100);
    assert.match(disclose(tier).sitAndGo, /goes to the prize pool/);
  }
});

await test("3,000 random hands: chips conserved, stacks never negative, every hand replays identically", () => {
  const t: TableState = newTable();
  let totalIn = 0;
  let totalRake = 0;
  const seatUp = (i: number) => {
    t.seats[i] = newSeat(`p${i}-${t.handNo}`, `P${i}`, true, BUY_IN, "r");
    totalIn += BUY_IN;
  };
  for (let i = 0; i < 4; i++) seatUp(i);
  for (let hand = 0; hand < 3000; hand++) {
    for (let i = 0; i < 4; i++) {
      if (t.seats[i]!.stack === 0) seatUp(i);
    }
    assert.ok(startHand(t, secureShuffle(freshDeck()), [], "c"));
    let guard = 0;
    while (!t.hand!.result) {
      const seat = t.hand!.toAct;
      const legal = legalActions(t, seat)!;
      const r = Math.random();
      // 10% of decisions come from the real bot, the rest are random legal moves
      let a = r < 0.1 ? decide(botView(t, seat, BIG_BLIND)!).action : null;
      if (!a) {
        const x = Math.random();
        if (x < 0.15) a = { type: "fold" };
        else if (x < 0.7) a = legal.check ? { type: "check" } : { type: "call" };
        else if (x < 0.95 && legal.canRaise)
          a = { type: "raise", to: legal.minRaiseTo + Math.floor(Math.random() * (legal.maxRaiseTo - legal.minRaiseTo + 1)) };
        else a = { type: "allin" };
      }
      const err = act(t, seat, a);
      assert.equal(err, null, `hand ${hand}: ${JSON.stringify(a)} -> ${err}`);
      assert.ok(++guard < 200, "hand did not terminate");
    }
    totalRake += t.hand!.result!.rake;
    for (const s of t.seats) assert.ok(s!.stack >= 0);
    assert.equal(chipsOnTable(t) + totalRake, totalIn, `chips not conserved after hand ${hand}`);
    const hist = historyOf("test", t);
    assert.deepEqual(replayHand(JSON.parse(JSON.stringify(hist))), hist.result, `replay mismatch on hand ${hand}`);
  }
  // buildPots on a finished hand is still callable (sanity)
  assert.ok(Array.isArray(buildPots(t)));
});

await test("replay uses the table's own house-cut rule (free-play tables take 0%)", () => {
  const t = newTable();
  t.rake = { percent: 0, cap: 0, noFlopNoDrop: true };
  t.seats[0] = newSeat("a", "A", false, 500, "r");
  t.seats[1] = newSeat("b", "B", false, 500, "r");
  startHand(t, freshDeck(), [], "c");
  act(t, t.hand!.toAct, { type: "allin" });
  act(t, t.hand!.toAct, { type: "call" });
  assert.equal(t.hand!.result!.rake, 0);
  const hist = JSON.parse(JSON.stringify(historyOf("test", t)));
  assert.deepEqual(replayHand(hist), hist.result);
});

/** Play a 4-handed hand to showdown, as the table does it (commit first, then mix in seeds), and return what player `me` receives. */
async function showdownFor(me: number, seeds: string[] = []) {
  const t = newTable();
  for (let i = 0; i < 4; i++) t.seats[i] = newSeat(`p${i}`, `P${i}`, false, 500, "r");
  t.button = 1; // button moves to seat 2
  const serverDeck = secureShuffle(freshDeck());
  const salts = serverDeck.map(() => randomHex(8));
  const { commit, leaves } = await commitDeck(serverDeck, salts);
  const perm = await permutationFrom(commit, [...seeds].sort());
  startHand(t, perm.map((j) => serverDeck[j]), salts, commit, { serverDeck, seeds: [...seeds].sort() });
  act(t, t.hand!.toAct, { type: "fold" });
  while (!t.hand!.result) act(t, t.hand!.toAct, legalActions(t, t.hand!.toAct)!.check ? { type: "check" } : { type: "call" });
  const h = t.hand!;
  const holes: Record<number, string[]> = { [me]: t.seats[me]!.hole };
  for (const [seat, shown] of Object.entries(h.result!.shown)) holes[+seat] = shown.hole;
  const input = { commit, reveal: revealFor(h, leaves, t.seats[me]!.hole), seeds: h.seeds ?? [], button: h.button, dealtIn: t.seats.map((s) => !!s?.inHand), board: [...h.board], holes };
  return { input, h, leaves };
}

await test("fairness check passes an honest hand for every seat", async () => {
  for (let me = 0; me < 4; me++) assert.ok(await verifyDeal((await showdownFor(me)).input), `seat ${me}`);
});

await test("fairness check catches cards that didn't come from their place in the committed deck", async () => {
  const { input, h, leaves } = await showdownFor(0);
  // A cheating server swaps the river for the card at the bottom of the deck, then reveals that position.
  // The commitment still hashes correctly; only the position check can catch it.
  const swapped = h.deck[51];
  const board = [...input.board.slice(0, 4), swapped];
  const reveal = revealFor({ ...h, board }, leaves, input.holes[0]);
  assert.ok(!(await verifyDeal({ ...input, board, reveal })), "a board card from the wrong position must fail");
  // ...and a fingerprint swapped after the deal fails too
  assert.ok(!(await verifyDeal({ ...input, commit: "0".repeat(64) })));
  // ...and claiming different hole cards for yourself fails
  const fakeHole = [h.deck[50], h.deck[49]];
  assert.ok(!(await verifyDeal({ ...input, holes: { ...input.holes, 0: fakeHole }, reveal: revealFor(h, leaves, fakeHole) })));
});

await test("fast hand scorer matches the reference on 60,000 random 5-, 6- and 7-card hands", () => {
  for (let i = 0; i < 20000; i++) {
    const d = secureShuffle(freshDeck());
    for (const k of [5, 6, 7]) assert.equal(bestScore(d.slice(0, k)), bestScoreReference(d.slice(0, k)), d.slice(0, k).join(" "));
  }
});

await test("preflop table: 169 hands, sensible order, equity falls as opponents are added", () => {
  assert.equal(Object.keys(PREFLOP_EQUITY).length, 169);
  const e = (h: string) => PREFLOP_EQUITY[h][0];
  assert.ok(e("AA") > e("KK") && e("KK") > e("AKs") && e("AKs") > e("AKo") && e("AKo") > e("72o"));
  for (const [h, [one, two, three]] of Object.entries(PREFLOP_EQUITY)) assert.ok(one > two && two > three, h);
  assert.equal(handClass(["Ah", "Kh"]), "AKs");
  assert.equal(handClass(["2c", "7d"]), "72o");
});

await test("a bot sees only its own cards and public play: hidden cards and deck order can't change its view or move", () => {
  const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 200; trial++) {
    const t = newTable();
    for (let i = 0; i < 4; i++) t.seats[i] = newSeat(`p${i}`, `P${i}`, true, 500, "r");
    startHand(t, secureShuffle(freshDeck()), [], "c");
    // play a little so there's public betting and maybe a board
    for (let k = 0; k < trial % 6 && !t.hand!.result; k++) act(t, t.hand!.toAct, legalActions(t, t.hand!.toAct)!.check ? { type: "check" } : { type: "call" });
    if (t.hand!.result) continue;
    const seat = t.hand!.toAct;
    const before = botView(t, seat, BIG_BLIND)!;
    const moveBefore = decide(before, seeded(trial));
    // Swap every card the bot shouldn't know: other players' hole cards and the undealt deck
    const visible = new Set([...t.seats[seat]!.hole, ...t.hand!.board]);
    const hidden = freshDeck().filter((c) => !visible.has(c));
    const reshuffled = secureShuffle(hidden);
    let k = 0;
    t.seats.forEach((s, i) => { if (s && i !== seat) s.hole = s.hole.map(() => reshuffled[k++]); });
    t.hand!.deck = t.hand!.deck.map((c) => (visible.has(c) ? c : reshuffled[k++ % reshuffled.length]));
    const after = botView(t, seat, BIG_BLIND)!;
    assert.deepEqual(after, before, "the view changed when hidden cards changed");
    assert.deepEqual(decide(after, seeded(trial)), moveBefore, "the move changed when hidden cards changed");
    const json = JSON.stringify(after);
    t.seats.forEach((s, i) => { if (s && i !== seat) for (const c of s.hole) assert.ok(!json.includes(`"${c}"`) || visible.has(c), `view leaks ${c}`); });
  }
});

await test("player seeds: an honest seeded deal verifies for every seat; a changed, added or dropped seed fails", async () => {
  const seeds = [newSeed(), newSeed(), newSeed()];
  for (let me = 0; me < 4; me++) assert.ok(await verifyDeal((await showdownFor(me, seeds)).input), `seat ${me}`);
  const { input } = await showdownFor(0, seeds);
  assert.ok(!(await verifyDeal({ ...input, seeds: [...input.seeds.slice(1), newSeed()] })), "changed seed");
  assert.ok(!(await verifyDeal({ ...input, seeds: [...input.seeds, newSeed()] })), "extra seed");
  assert.ok(!(await verifyDeal({ ...input, seeds: input.seeds.slice(1) })), "dropped seed");
});

await test("player seeds decide the final order: same committed deck, different seeds, different deal", async () => {
  const commit = "ab".repeat(32);
  const a = await permutationFrom(commit, [newSeed()]);
  const b = await permutationFrom(commit, [newSeed()]);
  for (const p of [a, b]) assert.deepEqual([...p].sort((x, y) => x - y), [...Array(52).keys()], "not a permutation");
  assert.notDeepEqual(a, b);
  assert.deepEqual(await permutationFrom(commit, ["01".repeat(16), "02".repeat(16)]), await permutationFrom(commit, ["02".repeat(16), "01".repeat(16)]), "seed order must not matter");
  assert.deepEqual(await permutationFrom(commit, []), [...Array(52).keys()], "no seeds: dealt as committed");
  // Every card lands in every position about equally often (no bias from the mixing)
  const counts = Array.from({ length: 52 }, () => new Array(52).fill(0));
  for (let i = 0; i < 2000; i++) (await permutationFrom(commit, [newSeed()])).forEach((src, pos) => counts[pos][src]++);
  const flat = counts.flat();
  assert.ok(Math.min(...flat) > 10 && Math.max(...flat) < 80, `uneven placement: ${Math.min(...flat)}..${Math.max(...flat)} (expect ~38)`);
});

console.log(`\n${passed} tests passed`);
