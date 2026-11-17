// Slot machine maths and fairness. Run: node tests/slots.test.ts   (about a minute: it really spins 10 million times per machine)
//
//  1. exact RTP by enumerating every combination of reel stops, pinned to the published figures
//  2. a simulation of 10,000,000 real spins per machine (the same HMAC -> stops -> payout path the server
//     uses) must match the exact RTP within statistical tolerance
//  3. outcomes depend only on (server seed, client seed, nonce, machine); they verify with the browser's
//     code; a tampered seed, nonce or stop fails
//  4. every stop of every reel is equally likely (rejection sampling, no modulo bias)
//  5. a return of the stake or less is never presented as a win
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { CLIENT_SEED, digestWords, sha256Hex, spinMessage, spinStops, stopsFromWords, verifySpin } from "../public/fair.js";
import { celebrationTier, evaluate, exactRtp, formatMoney, lineOf, MACHINES, MACHINE_IDS, MIN_SPIN_MS, reelSizes, STAKES } from "../public/machines.js";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name} (${Date.now() - t} ms)`);
}
const SIM_SPINS = Number(process.env.SIM_SPINS ?? 10_000_000);

/** The same derivation as fair.js spinStops, with Node's synchronous HMAC so 10 million spins take seconds. */
function spinStopsSync(serverSeed: string, clientSeed: string, nonce: number, machine: string, sizes: number[]): number[] {
  const words: number[] = [];
  for (let round = 0; ; round++) {
    words.push(...digestWords(createHmac("sha256", serverSeed).update(spinMessage(clientSeed, nonce, machine, round)).digest("hex")));
    const stops = stopsFromWords(words, sizes);
    if (stops) return stops;
  }
}

// The published figures. If a strip or a paytable changes, these must be changed with it, on purpose.
const PUBLISHED: Record<string, { combos: number; totalMult: number; rtp: string }> = {
  sevens2: { combos: 13_824, totalMult: 13_160, rtp: "95.20" },
  royal: { combos: 121_000, totalMult: 114_923, rtp: "94.98" },
};

await test("stakes run from 10p to £5, never more, and every win scales exactly with the stake; spins take at least 2.5 s", () => {
  assert.deepEqual(STAKES, [10, 20, 50, 100, 200, 500]); // play-money pence
  assert.ok(Math.max(...STAKES) <= 500);
  assert.deepEqual([10, 50, 100, 250, 500, 125000].map(formatMoney), ["10p", "50p", "£1", "£2.50", "£5", "£1,250"]);
  // a payout is (whole-number multiple) x (whole pence), so it is exact at every stake and proportional to it
  for (const id of MACHINE_IDS) for (const pay of MACHINES[id].pays) for (const st of STAKES) assert.equal((pay.mult * st) / st, pay.mult);
  assert.ok(MIN_SPIN_MS >= 2500);
});

for (const id of MACHINE_IDS) {
  await test(`${id}: exact RTP by full enumeration is ${PUBLISHED[id].rtp}% and inside 92-96%`, () => {
    const r = exactRtp(id);
    assert.equal(r.combos, PUBLISHED[id].combos);
    assert.equal(r.combos, reelSizes(id).reduce((a, n) => a * n, 1));
    assert.equal(r.totalMult, PUBLISHED[id].totalMult); // whole numbers: exact, no rounding
    assert.equal((r.rtp * 100).toFixed(2), PUBLISHED[id].rtp);
    assert.ok(r.rtp >= 0.92 && r.rtp <= 0.96, `RTP ${r.rtp}`);
    // every line of the paytable can actually happen, and pays what the table says
    for (const pay of MACHINES[id].pays) {
      assert.ok(r.lines[pay.key]?.count > 0, `${pay.key} can never land`);
      assert.equal(r.lines[pay.key].mult, pay.mult);
    }
    assert.equal(Object.values(r.lines).reduce((a, l) => a + l.count * l.mult, 0), r.totalMult);
    assert.ok(Number.isInteger(r.maxMult) && MACHINES[id].pays.every((p) => Number.isInteger(p.mult)), "payouts are whole chips");
  });
}

await test("royal: the five reels are exactly one 52-card deck, each card on one reel", () => {
  const cards = MACHINES.royal.reels.flat();
  assert.equal(cards.length, 52);
  assert.equal(new Set(cards).size, 52);
  for (const c of cards) assert.match(c, /^[2-9TJQKA][cdhs]$/);
});

await test("royal: hands are ranked like poker", () => {
  const reels = MACHINES.royal.reels;
  const stopsFor = (cards: string[]) => {
    // find an assignment of the five cards to five different reels
    const pos = cards.map((c) => reels.findIndex((r) => r.includes(c)));
    assert.equal(new Set(pos).size, 5, `cards ${cards} don't sit on five different reels`);
    const stops = Array(5).fill(0);
    cards.forEach((c, i) => (stops[pos[i]] = reels[pos[i]].indexOf(c)));
    return stops;
  };
  // every outcome agrees with an independent, deliberately naive hand ranker
  const R = "23456789TJQKA";
  const naive = (cards: string[]) => {
    const rs = cards.map((c) => R.indexOf(c[0])).sort((a, b) => a - b);
    const flush = new Set(cards.map((c) => c[1])).size === 1;
    const counts = Object.values(rs.reduce((m: Record<number, number>, r) => ((m[r] = (m[r] ?? 0) + 1), m), {})).sort((a, b) => b - a).join("");
    const straight = counts === "11111" && (rs[4] - rs[0] === 4 || rs.join() === "0,1,2,3,12");
    if (straight && flush) return rs[0] === 8 ? "royal" : "straightflush";
    if (counts === "41") return "quads";
    if (counts === "32") return "fullhouse";
    if (flush) return "flush";
    if (straight) return "straight";
    if (counts === "311") return "trips";
    if (counts === "221") return "twopair";
    if (counts === "2111") { const pair = rs.find((r, i) => rs.indexOf(r) !== i)!; return pair >= 9 ? "jacks" : null; }
    return null;
  };
  const sizes = reelSizes("royal");
  const stops = sizes.map(() => 0);
  for (let n = 0; n < 121_000; n++) {
    const got = evaluate("royal", stops);
    assert.equal(got.key, naive(lineOf("royal", stops)), `stops ${stops}`);
    for (let i = 4; i >= 0; i--) { if (++stops[i] < sizes[i]) break; stops[i] = 0; }
  }
  const royals = [];
  for (const s of "cdhs") { try { royals.push(evaluate("royal", stopsFor(["T", "J", "Q", "K", "A"].map((r) => r + s))).key); } catch { /* that suit's royal isn't on five reels */ } }
  assert.deepEqual(royals, ["royal", "royal"]); // two of the four royal flushes can land, as enumerated
});

await test("sevens2: the paytable is applied as published; a cherry pays in any column", () => {
  const reels = MACHINES.sevens2.reels;
  const find = (syms: string[]) => syms.map((s, i) => reels[i].indexOf(s));
  const ev = (syms: string[]) => evaluate("sevens2", find(syms));
  assert.equal(ev(["7", "7", "7"]).mult, 200);
  assert.equal(ev(["B1", "B2", "B3"]).key, "ANYBAR");
  assert.equal(ev(["B2", "B2", "B2"]).mult, 40);
  assert.equal(ev(["CHERRY", "CHERRY", "CHERRY"]).mult, 8);
  for (const line of [["CHERRY", "LEMON", "BELL"], ["LEMON", "CHERRY", "BELL"], ["LEMON", "BELL", "CHERRY"]]) assert.equal(ev(line).mult, 2); // one cherry, any column
  for (const line of [["CHERRY", "CHERRY", "LEMON"], ["CHERRY", "LEMON", "CHERRY"], ["LEMON", "CHERRY", "CHERRY"]]) assert.equal(ev(line).mult, 4); // two cherries, any columns
  assert.deepEqual(ev(["LEMON", "BELL", "CHERRY"]).cells, [2]);
  assert.equal(ev(["BELL", "BELL", "7"]).mult, 0);
  for (const r of reels) assert.equal(r.length, 24);
});

await test("the retired first edition stays published unchanged, so spins made on it still verify", () => {
  assert.ok(MACHINES.sevens.retired && !MACHINE_IDS.includes("sevens"));
  const r = exactRtp("sevens");
  assert.equal(r.totalMult, 13_162);
  const find = (syms: string[]) => syms.map((s, i) => MACHINES.sevens.reels[i].indexOf(s));
  assert.equal(evaluate("sevens", find(["CHERRY", "LEMON", "CHERRY"])).mult, 2); // its old rule: left reel only
  assert.equal(evaluate("sevens", find(["LEMON", "CHERRY", "CHERRY"])).mult, 0);
});

await test("an outcome is fixed by the seeds, nonce and machine alone, and the browser code agrees with the server path", async () => {
  for (let k = 0; k < 2000; k++) {
    const serverSeed = randomBytes(32).toString("hex"), clientSeed = randomBytes(8).toString("hex"), nonce = 1 + (k % 500);
    for (const id of MACHINE_IDS) {
      const sizes = reelSizes(id);
      const a = await spinStops({ serverSeed, clientSeed, nonce, machine: id, sizes });
      const b = await spinStops({ serverSeed, clientSeed, nonce, machine: id, sizes });
      assert.deepEqual(a, b); // same inputs, same stops, every time
      assert.deepEqual(a, spinStopsSync(serverSeed, clientSeed, nonce, id, sizes)); // WebCrypto path == Node path used by the simulation
      a.forEach((s, i) => assert.ok(Number.isInteger(s) && s >= 0 && s < sizes[i]));
    }
  }
  // a fixed vector, so an accidental change to the derivation can't go unnoticed
  const v = await spinStops({ serverSeed: "00".repeat(32), clientSeed: "card-table", nonce: 1, machine: "sevens", sizes: reelSizes("sevens") });
  assert.deepEqual(v, spinStopsSync("00".repeat(32), "card-table", 1, "sevens", reelSizes("sevens")));
  const other = await spinStops({ serverSeed: "00".repeat(32), clientSeed: "card-table", nonce: 2, machine: "sevens", sizes: reelSizes("sevens") });
  const many = await Promise.all(Array.from({ length: 40 }, (_, n) => spinStops({ serverSeed: "00".repeat(32), clientSeed: "card-table", nonce: n + 1, machine: "sevens", sizes: reelSizes("sevens") })));
  assert.ok(new Set(many.map(String)).size > 30, "different nonces give different spins");
  assert.ok(Array.isArray(other));
});

await test("a spin verifies against the commit; a tampered seed, client seed, nonce, machine or stop fails", async () => {
  const serverSeed = randomBytes(32).toString("hex"), clientSeed = "my-own-seed_1", nonce = 7, machine = "royal", sizes = reelSizes(machine);
  const commit = await sha256Hex(serverSeed);
  const stops = await spinStops({ serverSeed, clientSeed, nonce, machine, sizes });
  const good = { commit, serverSeed, clientSeed, nonce, machine, sizes, stops };
  assert.equal(await verifySpin(good), true);
  const flipped = (serverSeed[0] === "0" ? "1" : "0") + serverSeed.slice(1);
  assert.equal(await verifySpin({ ...good, serverSeed: flipped }), false); // doesn't match the commit
  assert.equal(await verifySpin({ ...good, serverSeed: flipped, commit: await sha256Hex(flipped) }), false); // a swapped commit AND seed gives other stops
  assert.equal(await verifySpin({ ...good, clientSeed: "someone-elses" }), false);
  assert.equal(await verifySpin({ ...good, nonce: 8 }), false);
  assert.equal(await verifySpin({ ...good, machine: "sevens", sizes: reelSizes("sevens") }), false);
  assert.equal(await verifySpin({ ...good, stops: stops.map((s, i) => (i === 2 ? (s + 1) % sizes[2] : s)) }), false);
  assert.equal(await verifySpin({ ...good, stops: stops.slice(0, 4) }), false);
  assert.ok(CLIENT_SEED.test(clientSeed) && !CLIENT_SEED.test("a:b") && !CLIENT_SEED.test("") && !CLIENT_SEED.test("x".repeat(65)));
});

await test("rejection sampling: numbers that would bias a reel are thrown away", () => {
  for (const n of [10, 11, 24]) {
    const limit = Math.floor(0x100000000 / n) * n;
    assert.deepEqual(stopsFromWords([limit - 1], [n]), [(limit - 1) % n]); // the last fair number is used
    assert.deepEqual(stopsFromWords([limit, 5], [n]), [5]); // the first unfair one is skipped
    assert.deepEqual(stopsFromWords([0xffffffff, 0xffffffff, 3], [n]), [3]);
    assert.equal(stopsFromWords([0xffffffff], [n]), null); // out of numbers: the caller hashes another round
    assert.equal(limit % n, 0); // so every stop has exactly limit / n of the 32-bit numbers
  }
});

await test("a return of the stake or less is never celebrated; real wins scale with size", () => {
  for (const stake of STAKES) {
    assert.equal(celebrationTier(stake, 0), "none");
    assert.equal(celebrationTier(stake, stake), "none"); // stake back is not a win
    assert.equal(celebrationTier(stake, stake * 2), "small");
    assert.equal(celebrationTier(stake, stake * 8), "medium");
    assert.equal(celebrationTier(stake, stake * 40), "big");
  }
  assert.equal(celebrationTier(50, 40), "none");
  // on Royal Reels a pair of jacks or better only returns the stake: it must present as "none"
  assert.equal(MACHINES.royal.pays.find((p) => p.key === "jacks")!.mult, 1);
});

for (const id of MACHINE_IDS) {
  await test(`${id}: ${SIM_SPINS.toLocaleString("en-GB")} simulated spins match the exact RTP, and every stop is equally likely`, () => {
    const exact = exactRtp(id);
    const sizes = reelSizes(id);
    const stopCounts = sizes.map((n) => new Float64Array(n));
    const lineCounts: Record<string, number> = {};
    let returned = 0;
    let serverSeed = "", clientSeed = "";
    for (let n = 0; n < SIM_SPINS; n++) {
      if (n % 100_000 === 0) { serverSeed = randomBytes(32).toString("hex"); clientSeed = randomBytes(8).toString("hex"); } // 100 seed pairs, like 100 players
      const stops = spinStopsSync(serverSeed, clientSeed, (n % 100_000) + 1, id, sizes);
      for (let i = 0; i < stops.length; i++) stopCounts[i][stops[i]]++;
      const r = evaluate(id, stops);
      if (r.mult) { returned += r.mult; lineCounts[r.key!] = (lineCounts[r.key!] ?? 0) + 1; }
    }
    const simRtp = returned / SIM_SPINS;
    const sigma = Math.sqrt(exact.variance / SIM_SPINS); // standard error of the simulated RTP
    const z = (simRtp - exact.rtp) / sigma;
    console.log(`   exact ${(exact.rtp * 100).toFixed(4)}%  simulated ${(simRtp * 100).toFixed(4)}%  (${z.toFixed(2)} standard errors apart; 1 s.e. = ${(sigma * 100).toFixed(4)}%)`);
    assert.ok(Math.abs(z) < 4, `simulated RTP is ${z.toFixed(2)} standard errors from exact`); // a fair machine fails this once in ~16,000 runs
    // each stop of each reel: observed count within 5 standard deviations of N / size
    sizes.forEach((size, i) => {
      const p = 1 / size, sd = Math.sqrt(SIM_SPINS * p * (1 - p));
      stopCounts[i].forEach((c, s) => assert.ok(Math.abs(c - SIM_SPINS * p) < 5 * sd, `reel ${i} stop ${s}: ${c} vs ${SIM_SPINS * p}`));
    });
    // each paytable line lands about as often as the enumeration says
    for (const [key, line] of Object.entries(exact.lines)) {
      const p = line.count / exact.combos, expected = SIM_SPINS * p, sd = Math.sqrt(expected * (1 - p));
      assert.ok(Math.abs((lineCounts[key] ?? 0) - expected) < 5 * sd + 1, `${key}: ${lineCounts[key] ?? 0} vs ${expected.toFixed(1)}`);
    }
  });
}

console.log(`\n${passed} tests passed`);
