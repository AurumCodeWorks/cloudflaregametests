// AI opponents. Always shown as bots in the UI.
// Strategy: Monte Carlo equity against the remaining opponents, compared with pot odds,
// plus a little randomness so bots are not perfectly predictable.

import { bestScore, freshDeck } from "./cards.ts";
import { BIG_BLIND, legalActions, potTotal } from "./holdem.ts";
import type { Action, TableState } from "./holdem.ts";

export const BOT_NAMES = ["Ada (bot)", "Turing (bot)", "Hopper (bot)", "Lovelace (bot)", "Knuth (bot)", "Shannon (bot)"];

/** Estimated chance of winning at showdown against `opponents` random hands. */
export function equity(hole: string[], board: string[], opponents: number, iterations = 250): number {
  const known = new Set([...hole, ...board]);
  const rest = freshDeck().filter((c) => !known.has(c));
  let wins = 0;
  for (let it = 0; it < iterations; it++) {
    // partial Fisher-Yates (Math.random is fine for bot thinking; it never touches the real deck)
    const need = opponents * 2 + (5 - board.length);
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (rest.length - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const fullBoard = board.concat(rest.slice(opponents * 2, need));
    const mine = bestScore(hole.concat(fullBoard));
    let best = true;
    let tie = false;
    for (let o = 0; o < opponents; o++) {
      const theirs = bestScore([rest[o * 2], rest[o * 2 + 1], ...fullBoard]);
      if (theirs > mine) {
        best = false;
        break;
      }
      if (theirs === mine) tie = true;
    }
    if (best) wins += tie ? 0.5 : 1;
  }
  return wins / iterations;
}

export function decide(t: TableState, seat: number): Action {
  const legal = legalActions(t, seat);
  const h = t.hand!;
  const s = t.seats[seat]!;
  if (!legal) return { type: "fold" };
  const opponents = t.seats.filter((o, i) => o && i !== seat && o.inHand && !o.folded).length;
  const eq = equity(s.hole, h.board, Math.max(1, opponents));
  const pot = potTotal(t);
  const toCall = legal.call;
  const potOdds = toCall / (pot + toCall || 1);
  const r = Math.random();

  const raiseTo = (target: number): Action => {
    const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(target / BIG_BLIND) * BIG_BLIND));
    return to >= legal.maxRaiseTo ? { type: "allin" } : { type: "raise", to };
  };

  if (toCall === 0) {
    if (legal.canRaise && (eq > 0.62 || r < 0.07)) return raiseTo(h.currentBet + Math.max(BIG_BLIND, pot * 0.6));
    return { type: "check" };
  }
  if (legal.canRaise && eq > 0.75 && r < 0.8) return raiseTo(h.currentBet + Math.max(h.minRaise, pot * 0.75));
  if (eq >= potOdds + 0.03) return { type: "call" };
  if (legal.canRaise && r < 0.03) return raiseTo(legal.minRaiseTo);
  return { type: "fold" };
}
