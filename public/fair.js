// Provably-fair shuffle, shared by the server, the live client, the showroom and the Node tests.
//
// 1. Before players add anything, the server shuffles its deck and publishes
//    commit = sha256(leaf0,...,leaf51), leaf = sha256("<card>:<salt>"). That fixes the house's deck.
// 2. Each player's browser then sends a random seed of its own.
// 3. At the deal, the server reorders its committed deck with a permutation derived from the commit
//    and every seed received (permutationFrom). The house can't pick the final deck (it committed first);
//    no player can steer it (nobody but the dealer knows the committed deck).
// After the hand each player gets, for every position of the committed deck, either {card, salt}
// (a card they saw) or just {leaf}, plus the seeds, and can check everything below.

export async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * The reordering applied to the committed deck: card i of the dealt deck is committed card perm[i].
 * Derived from sha256(commit | sorted seeds) as a counter-mode stream with unbiased Fisher-Yates.
 * With no seeds the committed deck is dealt as it is.
 */
export async function permutationFrom(commit, seeds = []) {
  const perm = Array.from({ length: 52 }, (_, i) => i);
  if (!seeds.length) return perm;
  const mix = await sha256Hex(`${commit}|${[...seeds].sort().join(",")}`);
  const words = [];
  let counter = 0;
  const next32 = async () => {
    if (!words.length) {
      const h = await sha256Hex(`${mix}:${counter++}`);
      for (let i = 0; i < 64; i += 8) words.push(parseInt(h.slice(i, i + 8), 16));
    }
    return words.shift();
  };
  for (let i = 51; i > 0; i--) {
    const n = i + 1, limit = Math.floor(0x100000000 / n) * n; // rejection sampling: no modulo bias
    let x;
    do x = await next32(); while (x >= limit);
    const j = x % n;
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/** A fresh random seed for this player's contribution to the next shuffle (16 bytes, hex). */
export function newSeed() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Where each card comes from in the deck, mirroring the engine (src/holdem.ts): two rounds of one hole
 * card each, starting left of the button, then burn + flop, burn + turn, burn + river.
 * `dealtIn[i]` says whether seat i was dealt into the hand.
 */
export function dealPositions(button, dealtIn) {
  const n = dealtIn.length;
  const order = [];
  for (let k = 1; k <= n; k++) if (dealtIn[(button + k) % n]) order.push((button + k) % n);
  const c = order.length;
  const hole = {};
  order.forEach((seat, k) => (hole[seat] = [k, c + k]));
  return { hole, board: [2 * c + 1, 2 * c + 2, 2 * c + 3, 2 * c + 5, 2 * c + 7] };
}

/**
 * True only if the revealed deck hashes to the fingerprint published before the deal AND every card
 * you saw (board, your hole cards, hands shown at showdown) sat at its proper place in the dealt deck
 * (the committed deck reordered by the players' seeds).
 * Without the position check any card would "verify", since every card is somewhere in a deck.
 */
export async function verifyDeal({ commit, reveal, seeds = [], button, dealtIn, board, holes }) {
  if (!Array.isArray(reveal) || reveal.length !== 52) return false;
  const leaves = await Promise.all(reveal.map((r) => ("leaf" in r ? r.leaf : sha256Hex(`${r.card}:${r.salt}`))));
  if ((await sha256Hex(leaves.join(","))) !== commit) return false;
  const perm = await permutationFrom(commit, seeds);
  const pos = dealPositions(button, dealtIn);
  const at = (p) => reveal[perm[p]]?.card; // dealt position p holds committed card perm[p]
  if (!board.every((card, k) => at(pos.board[k]) === card)) return false;
  return Object.entries(holes).every(([seat, cards]) => pos.hole[seat] && cards.every((card, k) => at(pos.hole[seat][k]) === card));
}

// ---------------------------------------------------------------------------------------------
// Provably-fair slot spins (shared by the server, the browser and the Node tests).
//
// 1. The server picks a secret seed and publishes commit = sha256(serverSeed) BEFORE any spin.
// 2. The player supplies a client seed of their own; a nonce counts the spins made with this pair.
// 3. Each spin's reel stops come from HMAC-SHA256(key = serverSeed, message = "clientSeed:nonce:machine:round"),
//    read as eight 32-bit numbers. Each reel takes the next number; numbers that would bias the result
//    are rejected (rejection sampling), so every stop on a reel is exactly equally likely.
// 4. When the player changes seeds, the old server seed is revealed. Anyone can then re-run steps 3
//    for every past spin and check the seed against the commit that was shown beforehand.

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** The message hashed for one round of one spin. */
export const spinMessage = (clientSeed, nonce, machine, round) => `${clientSeed}:${nonce}:${machine}:${round}`;

/** Eight unsigned 32-bit numbers from a 64-character hex digest. */
export function digestWords(digestHex) {
  const words = [];
  for (let i = 0; i < 64; i += 8) words.push(parseInt(digestHex.slice(i, i + 8), 16));
  return words;
}

/**
 * Map random 32-bit numbers to one stop per reel. `sizes[i]` is the number of stops on reel i.
 * A number at or above the largest multiple of the reel size is thrown away, so there is no modulo bias.
 * Returns null if the numbers run out (the caller hashes another round and calls again with more).
 */
export function stopsFromWords(words, sizes) {
  const stops = [];
  let k = 0;
  for (const n of sizes) {
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do {
      if (k >= words.length) return null;
      x = words[k++];
    } while (x >= limit);
    stops.push(x % n);
  }
  return stops;
}

/** The reel stops of one spin: fixed entirely by the two seeds, the nonce and the machine. */
export async function spinStops({ serverSeed, clientSeed, nonce, machine, sizes }) {
  const words = [];
  for (let round = 0; ; round++) {
    words.push(...digestWords(await hmacSha256Hex(serverSeed, spinMessage(clientSeed, nonce, machine, round))));
    const stops = stopsFromWords(words, sizes);
    if (stops) return stops;
  }
}

/** Client seeds: 1-64 letters, digits, "-" or "_" (no ":" so the hashed message can't be ambiguous). */
export const CLIENT_SEED = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * True only if the revealed server seed matches the commit published before the spins AND it
 * reproduces exactly the stops the player was shown.
 */
export async function verifySpin({ commit, serverSeed, clientSeed, nonce, machine, sizes, stops }) {
  if ((await sha256Hex(serverSeed)) !== commit) return false;
  const expect = await spinStops({ serverSeed, clientSeed, nonce, machine, sizes });
  return Array.isArray(stops) && stops.length === expect.length && expect.every((s, i) => s === stops[i]);
}
