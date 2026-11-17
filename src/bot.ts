// AI opponents, always labelled as bots. A bot decides from a BotView: exactly what a person sitting in
// its seat could see (its own two cards, the board, the pot, stacks and the public betting). It is never
// handed the table state, so other players' cards and the deck order are out of its reach, and bots share
// nothing with each other.
//
// Work is only done when there's a real choice: a free check with nothing worth betting costs nothing,
// the first betting round uses a precomputed table, and later rounds simulate run-outs only until the
// answer is clear.
import { RANKS, SUITS, cardInt, scoreInts } from "./cards.ts";
import { legalActions, potTotal } from "./holdem.ts";
import type { Action, Street, TableState } from "./holdem.ts";
import { PREFLOP_EQUITY } from "./preflop.ts";

export const BOT_NAMES = ["Ada (bot)", "Turing (bot)", "Hopper (bot)", "Lovelace (bot)", "Knuth (bot)", "Shannon (bot)"];

/** What another player has shown publicly this hand. */
export interface OpponentInfo { stack: number; bet: number; allIn: boolean; raises: number; calls: number }
export interface BotView {
  hole: string[];
  board: string[];
  street: Street;
  pot: number;
  toCall: number;
  currentBet: number;
  canCheck: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  stack: number;
  bet: number;
  bigBlind: number;
  opponents: OpponentInfo[]; // players still in the hand
  actsLast: boolean; // nobody still to act after this bot on this street
}

/** Build a bot's view of the table. Only public information plus the bot's own cards goes in. */
export function botView(t: TableState, seat: number, bigBlind: number): BotView | null {
  const h = t.hand;
  const legal = legalActions(t, seat);
  if (!h || !legal) return null;
  const me = t.seats[seat]!;
  const n = t.seats.length;
  const opponents: OpponentInfo[] = [];
  t.seats.forEach((s, i) => {
    if (!s || i === seat || !s.inHand || s.folded) return;
    const mine = h.actions.slice(2).filter((a) => a.seat === i); // the first two records are the blinds
    opponents.push({
      stack: s.stack, bet: s.bet, allIn: s.allIn,
      raises: mine.filter((a) => a.type === "raise" || (a.type === "allin" && a.amount > 0)).length,
      calls: mine.filter((a) => a.type === "call").length,
    });
  });
  // Acts last on this street if no one who can still act sits between this seat and the button
  let actsLast = true;
  for (let k = 1; k < n; k++) {
    const i = (seat + k) % n;
    const s = t.seats[i];
    if (s && s.inHand && !s.folded && !s.allIn && h.street !== "preflop") actsLast = false;
    if (i === h.button) break;
  }
  return {
    hole: [...me.hole], board: [...h.board], street: h.street, pot: potTotal(t), toCall: legal.call,
    currentBet: h.currentBet, canCheck: legal.check, canRaise: legal.canRaise, minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo, stack: me.stack, bet: me.bet, bigBlind, opponents, actsLast,
  };
}

// ---------------------------------------------------------------- hand strength
/** Starting-hand type, e.g. "AKs", "T9o", "77". */
export function handClass(hole: string[]): string {
  const [a, b] = hole.map((c) => RANKS.indexOf(c[0]));
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  return RANKS[hi] + RANKS[lo] + (hole[0][1] === hole[1][1] ? "s" : "o");
}
/** Each starting hand's place among all 1,326 deals (0 = best, 1 = worst), from its heads-up equity. */
const PERCENTILE: Record<string, number> = (() => {
  const combos = (k: string) => (k.length === 2 ? 6 : k.endsWith("s") ? 4 : 12);
  const sorted = Object.keys(PREFLOP_EQUITY).sort((x, y) => PREFLOP_EQUITY[y][0] - PREFLOP_EQUITY[x][0]);
  const out: Record<string, number> = {};
  let seen = 0;
  for (const k of sorted) { out[k] = (seen + combos(k) / 2) / 1326; seen += combos(k); }
  return out;
})();
const CLASS_OF_INTS = (a: number, b: number) => {
  const ra = a >> 2, rb = b >> 2, hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  return hi === lo ? RANKS[hi] + RANKS[lo] : RANKS[hi] + RANKS[lo] + ((a & 3) === (b & 3) ? "s" : "o");
};
/** The range an opponent is likely to hold, from what they've done this hand (top fraction of hands). */
function rangeOf(o: OpponentInfo): number {
  if (o.raises >= 2) return 0.1;
  if (o.raises === 1) return 0.28;
  if (o.calls > 0) return 0.6;
  return 1;
}

const buf = new Int32Array(7);
/**
 * Chance of winning at showdown, simulating run-outs against each opponent's likely range.
 * Stops as soon as the estimate is clearly on one side of `threshold` (the decision boundary).
 */
export function equity(v: BotView, threshold: number, rand: () => number = Math.random, maxIter = 400): { eq: number; iterations: number } {
  const known = [...v.hole, ...v.board].map(cardInt);
  const pool: number[] = [];
  for (let c = 0; c < 52; c++) if (!known.includes(c)) pool.push(c);
  const ranges = v.opponents.map(rangeOf);
  const need = 5 - v.board.length;
  let won = 0, it = 0;
  for (; it < maxIter; it++) {
    let ptr = 0;
    const take = () => { const j = ptr + Math.floor(rand() * (pool.length - ptr)); [pool[ptr], pool[j]] = [pool[j], pool[ptr]]; return pool[ptr++]; };
    // Opponents' hands, drawn from their likely range (a few redraws, then accept)
    const opp: number[] = [];
    for (const cutoff of ranges) {
      const start = ptr;
      for (let tries = 0; ; tries++) {
        ptr = start;
        const a = take(), b = take();
        if (cutoff >= 1 || tries >= 12 || PERCENTILE[CLASS_OF_INTS(a, b)] <= cutoff) { opp.push(a, b); break; }
      }
    }
    for (let i = 0; i < v.board.length; i++) buf[2 + i] = known[2 + i];
    for (let i = 0; i < need; i++) buf[2 + v.board.length + i] = take();
    buf[0] = known[0]; buf[1] = known[1];
    const mine = scoreInts(buf, 7);
    let best = true, ties = 0;
    for (let o = 0; o < opp.length && best; o += 2) {
      buf[0] = opp[o]; buf[1] = opp[o + 1];
      const theirs = scoreInts(buf, 7);
      if (theirs > mine) best = false; else if (theirs === mine) ties++;
    }
    if (best) won += 1 / (ties + 1);
    if (it >= 59 && (it + 1) % 20 === 0) {
      const p = won / (it + 1);
      if (Math.abs(p - threshold) > 2.5 * Math.sqrt(Math.max(p * (1 - p), 0.01) / (it + 1))) { it++; break; }
    }
  }
  return { eq: won / it, iterations: it };
}

/** A flush draw or open-ended straight draw (worth an occasional semi-bluff on the flop and turn). */
function hasDraw(v: BotView): boolean {
  if (v.street !== "flop" && v.street !== "turn") return false;
  const cards = [...v.hole, ...v.board];
  for (const su of SUITS) if (cards.filter((c) => c[1] === su).length === 4 && v.hole.some((c) => c[1] === su)) return true;
  let mask = 0;
  for (const c of cards) mask |= 1 << RANKS.indexOf(c[0]);
  for (let lo = 0; lo <= 8; lo++) if (((mask >> lo) & 15) === 15) return true;
  return false;
}

// ---------------------------------------------------------------- the decision
export interface Decision { action: Action; difficulty: number; equity: number | null }

export function decide(v: BotView, rand: () => number = Math.random): Decision {
  const quick = (action: Action): Decision => ({ action, difficulty: 0, equity: null });
  if (v.canCheck && !v.canRaise) return quick({ type: "check" }); // nothing to decide

  const opps = Math.max(1, v.opponents.length);
  const fair = 1 / (opps + 1); // an even share of the pot
  const potOdds = v.toCall / (v.pot + v.toCall || 1);
  const valueAt = fair + 0.15; // bet or raise for value above this
  const raiseAt = fair + 0.3;
  const callAt = potOdds + 0.03;
  const boundary = v.toCall > 0 ? callAt : valueAt;

  // Preflop with no raise to face: the precomputed table is enough
  const facingRaise = v.opponents.some((o) => o.raises > 0);
  const eq = v.street === "preflop" && !facingRaise
    ? PREFLOP_EQUITY[handClass(v.hole)][Math.min(3, opps) - 1]
    : equity(v, boundary, rand).eq;
  const difficulty = Math.max(0, Math.min(1, 1 - Math.abs(eq - boundary) / 0.25));
  const r = rand();

  const bb = v.bigBlind;
  const round = (x: number) => Math.round(x / bb) * bb;
  const raiseTo = (target: number): Action => {
    if (!v.canRaise) return v.toCall > 0 ? { type: "call" } : { type: "check" };
    const to = Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, round(target)));
    // Committing most of the stack anyway: go all in rather than leave a sliver behind
    return to >= v.maxRaiseTo * 0.75 ? { type: "allin" } : { type: "raise", to };
  };
  const decision = (action: Action): Decision => ({ action, difficulty, equity: eq });
  const preflop = v.street === "preflop";

  if (v.toCall === 0) {
    const bluff = v.actsLast && opps <= 2 && r < 0.08;
    const semi = hasDraw(v) && r < 0.3;
    if (eq > valueAt || bluff || semi) {
      if (preflop) return decision(raiseTo(v.currentBet + bb * (1.5 + Math.round(r * 2)))); // raise to ~2.5-4 big blinds
      const size = eq > raiseAt ? 0.75 : 0.5;
      return decision(raiseTo(v.currentBet + v.pot * size));
    }
    return decision({ type: "check" });
  }
  // Facing a bet
  const cheapAllIn = v.toCall >= v.stack && eq > potOdds; // calling puts us all in and the price is right
  if (v.canRaise && eq > raiseAt && r < 0.75) {
    if (preflop) return decision(raiseTo(v.currentBet * 3));
    return decision(raiseTo(v.currentBet + (v.pot + v.toCall) * 0.75));
  }
  if (eq >= callAt || cheapAllIn) return decision({ type: "call" });
  if (v.canRaise && opps === 1 && r < 0.02) return decision(raiseTo(v.minRaiseTo)); // rare bluff-raise
  return decision({ type: "fold" });
}
