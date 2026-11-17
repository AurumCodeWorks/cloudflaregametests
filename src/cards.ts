// Cards, secure shuffling, hand evaluation and the provably-fair commitment.
// No Workers-only APIs: runs in Workers, Durable Objects and Node (for tests).

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

/** A card is two characters, e.g. "As" (ace of spades), "Td" (ten of diamonds). */
export function freshDeck(): string[] {
  const deck: string[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Unbiased random integer in [0, n) from the platform CSPRNG (rejection sampling, no modulo bias). */
function secureInt(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Fisher-Yates shuffle using the CSPRNG. */
export function secureShuffle(deck: string[]): string[] {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Provably fair deck commitment (per-card, so folded hands can stay private).
//   leaf[i]  = sha256("<card at position i>:<salt i>")
//   commit   = sha256(leaf[0] + "," + ... + leaf[51])      <- published before any card is dealt
// After the hand each player receives, for every position, either {card, salt} (cards they were
// allowed to see) or just {leaf} (cards that stay hidden), and can recompute the commitment.
// ---------------------------------------------------------------------------
export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function commitDeck(deck: string[], salts: string[]): Promise<{ commit: string; leaves: string[] }> {
  const leaves = await Promise.all(deck.map((c, i) => sha256Hex(`${c}:${salts[i]}`)));
  return { commit: await sha256Hex(leaves.join(",")), leaves };
}

export type RevealItem = { card: string; salt: string } | { leaf: string };

export async function verifyReveal(commit: string, reveal: RevealItem[]): Promise<boolean> {
  if (reveal.length !== 52) return false;
  const leaves = await Promise.all(reveal.map((r) => ("leaf" in r ? r.leaf : sha256Hex(`${r.card}:${r.salt}`))));
  return (await sha256Hex(leaves.join(","))) === commit;
}

// ---------------------------------------------------------------------------
// Hand evaluation. Score layout: category << 20 | five 4-bit tiebreak ranks.
// Higher score = better hand.
// ---------------------------------------------------------------------------
export const CATEGORY_NAMES = [
  "High card",
  "Pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
];

const rankValue = (c: string) => RANKS.indexOf(c[0]) + 2; // 2..14

function pack(cat: number, ranks: number[]): number {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + (ranks[i] ?? 0);
  return s;
}

export function eval5(cards: string[]): number {
  const rs = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(rs)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  if (straightHigh && flush) return pack(8, [straightHigh]);

  const counts = new Map<number, number>();
  for (const r of rs) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const order = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join("");

  if (shape === "41") return pack(7, order);
  if (shape === "32") return pack(6, order);
  if (flush) return pack(5, rs);
  if (straightHigh) return pack(4, [straightHigh]);
  if (shape === "311") return pack(3, order);
  if (shape === "221") return pack(2, order);
  if (shape === "2111") return pack(1, order);
  return pack(0, rs);
}

/** Best 5-card score from 5-7 cards (fast path: same scores as the reference below). */
export function bestScore(cards: string[]): number {
  for (let i = 0; i < cards.length; i++) scratch[i] = cardInt(cards[i]);
  return scoreInts(scratch, cards.length);
}

// ---------------------------------------------------------------------------
// Fast scorer. A card is an integer: rank index (0 = "2" .. 12 = "A") * 4 + suit index.
// One pass builds rank counts and bit masks; no 5-card combinations, no allocations.
// ---------------------------------------------------------------------------
export const cardInt = (c: string) => (RANKS.indexOf(c[0]) << 2) | SUITS.indexOf(c[1]);
const scratch = new Int32Array(7);
const rankCount = new Int32Array(13);
const suitCount = new Int32Array(4);
const suitMask = new Int32Array(4);

/** Highest straight in a 13-bit rank mask, as a rank index (wheel A-5 = 3), or -1. */
function straightTop(mask: number): number {
  for (let top = 12; top >= 4; top--) if (((mask >> (top - 4)) & 31) === 31) return top;
  return (mask & 0b1000000001111) === 0b1000000001111 ? 3 : -1;
}

/** Score `n` integer cards (5-7). Same layout as pack(): category, then up to five ranks (2..14). */
export function scoreInts(cs: ArrayLike<number>, n: number): number {
  rankCount.fill(0); suitCount.fill(0); suitMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const r = cs[i] >> 2, su = cs[i] & 3;
    rankCount[r]++; suitCount[su]++; suitMask[su] |= 1 << r; rankMask |= 1 << r;
  }
  let flushSuit = -1;
  for (let su = 0; su < 4; su++) if (suitCount[su] >= 5) flushSuit = su;
  if (flushSuit >= 0) {
    const sf = straightTop(suitMask[flushSuit]);
    if (sf >= 0) return packIdx(8, sf);
  }
  let quad = -1, trip1 = -1, trip2 = -1, pair1 = -1, pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c === 4) { if (quad < 0) quad = r; }
    else if (c === 3) { if (trip1 < 0) trip1 = r; else if (trip2 < 0) trip2 = r; }
    else if (c === 2) { if (pair1 < 0) pair1 = r; else if (pair2 < 0) pair2 = r; }
  }
  if (quad >= 0) return packIdx(7, quad, topRanks(rankMask & ~(1 << quad), 1));
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) return packIdx(6, trip1, Math.max(trip2, pair1));
  if (flushSuit >= 0) return packTop(5, suitMask[flushSuit]);
  const st = straightTop(rankMask);
  if (st >= 0) return packIdx(4, st);
  if (trip1 >= 0) return packIdx(3, trip1, topRanks(rankMask & ~(1 << trip1), 2));
  if (pair1 >= 0 && pair2 >= 0) return packIdx(2, pair1, pair2, topRanks(rankMask & ~(1 << pair1) & ~(1 << pair2), 1));
  if (pair1 >= 0) return packIdx(1, pair1, topRanks(rankMask & ~(1 << pair1), 3));
  return packTop(0, rankMask);
}
/** The highest `k` ranks in a mask, already packed as base-16 digits (rank values 2..14). */
function topRanks(mask: number, k: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < k; r--) if (mask & (1 << r)) out.push(r);
  return out;
}
function packIdx(cat: number, ...parts: (number | number[])[]): number {
  const ranks: number[] = [];
  for (const p of parts) typeof p === "number" ? ranks.push(p) : ranks.push(...p);
  let sc = cat;
  for (let i = 0; i < 5; i++) sc = sc * 16 + (i < ranks.length ? ranks[i] + 2 : 0);
  return sc;
}
function packTop(cat: number, mask: number): number {
  return packIdx(cat, topRanks(mask, 5));
}

/** Reference scorer: tries every 5-card combination with eval5. Slow, simple; the tests check the fast one against it. */
export function bestScoreReference(cards: string[]): number {
  let best = -1;
  const pick: string[] = [];
  const walk = (start: number) => {
    if (pick.length === 5) {
      const s = eval5(pick);
      if (s > best) best = s;
      return;
    }
    for (let i = start; i <= cards.length - (5 - pick.length); i++) {
      pick.push(cards[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best;
}

export function categoryName(score: number): string {
  return CATEGORY_NAMES[Math.floor(score / 16 ** 5)];
}
