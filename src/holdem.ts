// No-Limit Texas Hold'em rules engine.
// Pure functions over a plain JSON state, so it can be stored in a Durable Object,
// unit-tested in Node, and re-run from a saved hand history to verify the result.

import { bestScore, categoryName } from "./cards.ts";

export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;
export const BUY_IN = 500;
export const SEAT_COUNT = 4;
export const RAKE_PERCENT = 5;
export const RAKE_CAP = 3 * BIG_BLIND;

/**
 * The house's cut. This is the ONLY way the house earns from a poker hand: a disclosed
 * percentage of contested pots, capped, and only once a flop is dealt ("no flop, no drop").
 * The house never plays a hand and never influences the cards.
 */
export interface RakeRule {
  percent: number; // e.g. 5 = 5% of the contested pot
  cap: number; // maximum chips taken from one hand
  noFlopNoDrop: boolean;
}
export const DEFAULT_RAKE: RakeRule = { percent: RAKE_PERCENT, cap: RAKE_CAP, noFlopNoDrop: true };

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export interface Seat {
  userId: string;
  name: string;
  isBot: boolean;
  stack: number;
  sitRef: string; // ledger reference of this buy-in, reused for the matching cash-out
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  bet: number; // chips put in on the current street
  total: number; // chips put in during this hand
  hole: string[];
  acted: boolean;
  canRaise: boolean;
  leaving: boolean;
  timeouts: number;
}

export interface ActionRecord {
  street: Street;
  seat: number;
  type: ActionType;
  amount: number; // chips added by this action
  to: number; // the seat's street bet after the action
}

export interface PotResult {
  amount: number;
  eligible: number[];
  winners: number[];
}

export interface HandResult {
  endedBy: "fold" | "showdown";
  pots: PotResult[];
  rake: number;
  payouts: number[]; // chips received per seat (net of rake)
  shown: Record<number, { hole: string[]; hand: string }>;
}

export interface Hand {
  no: number;
  prevButton: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  deck: string[];
  ptr: number;
  board: string[];
  street: Street;
  toAct: number;
  currentBet: number;
  minRaise: number;
  actions: ActionRecord[];
  commit: string;
  salts: string[];
  startSeats: ({ userId: string; name: string; isBot: boolean; stack: number } | null)[];
  result: HandResult | null;
  finalized: boolean;
}

export interface TableState {
  seats: (Seat | null)[];
  button: number;
  handNo: number;
  hand: Hand | null;
  rake?: RakeRule; // per-table house cut (defaults to DEFAULT_RAKE); 0% for tournaments, whose fee is taken at entry
}

export type ActionType = "fold" | "check" | "call" | "raise" | "allin";
export interface Action {
  type: ActionType;
  to?: number; // raise-to amount (total street bet)
}

export interface Legal {
  fold: boolean;
  check: boolean;
  call: number; // 0 if no call possible
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export function newTable(): TableState {
  return { seats: Array(SEAT_COUNT).fill(null), button: -1, handNo: 0, hand: null };
}

export function newSeat(userId: string, name: string, isBot: boolean, stack: number, sitRef: string): Seat {
  return {
    userId, name, isBot, stack, sitRef,
    inHand: false, folded: false, allIn: false, bet: 0, total: 0, hole: [],
    acted: false, canRaise: true, leaving: false, timeouts: 0,
  };
}

const n = () => SEAT_COUNT;
function nextIdx(from: number, pred: (i: number) => boolean): number {
  for (let k = 1; k <= n(); k++) {
    const i = (((from + k) % n()) + n()) % n();
    if (pred(i)) return i;
  }
  return -1;
}

export function isActive(t: TableState, i: number): boolean {
  const s = t.seats[i];
  return !!s && s.inHand && !s.folded;
}
function canAct(t: TableState, i: number): boolean {
  const s = t.seats[i];
  return !!s && s.inHand && !s.folded && !s.allIn;
}

function put(s: Seat, amount: number): number {
  const amt = Math.min(amount, s.stack);
  s.stack -= amt;
  s.bet += amt;
  s.total += amt;
  if (s.stack === 0) s.allIn = true;
  return amt;
}

function deal(h: Hand): string {
  return h.deck[h.ptr++];
}

/** Start a hand with a pre-shuffled deck. Returns false if fewer than 2 players can play. */
export function startHand(t: TableState, deck: string[], salts: string[], commit: string): boolean {
  const eligible = (i: number) => !!t.seats[i] && t.seats[i]!.stack > 0;
  const count = t.seats.filter((_, i) => eligible(i)).length;
  if (count < 2) return false;

  const prevButton = t.button;
  const button = nextIdx(t.button, eligible);
  t.button = button;
  t.handNo++;

  for (let i = 0; i < n(); i++) {
    const s = t.seats[i];
    if (!s) continue;
    Object.assign(s, { inHand: eligible(i), folded: false, allIn: false, bet: 0, total: 0, hole: [], acted: false, canRaise: true });
  }

  let sbSeat: number, bbSeat: number, firstToAct: number;
  if (count === 2) {
    sbSeat = button; // heads-up: the button posts the small blind and acts first preflop
    bbSeat = nextIdx(button, eligible);
    firstToAct = sbSeat;
  } else {
    sbSeat = nextIdx(button, eligible);
    bbSeat = nextIdx(sbSeat, eligible);
    firstToAct = nextIdx(bbSeat, eligible);
  }

  const h: Hand = {
    no: t.handNo, prevButton, button, sbSeat, bbSeat, deck, ptr: 0, board: [], street: "preflop",
    toAct: -1, currentBet: BIG_BLIND, minRaise: BIG_BLIND, actions: [], commit, salts,
    startSeats: t.seats.map((s) => (s ? { userId: s.userId, name: s.name, isBot: s.isBot, stack: s.stack } : null)),
    result: null, finalized: false,
  };
  t.hand = h;

  // Deal two cards each, one at a time, starting left of the button
  for (let round = 0; round < 2; round++) {
    let i = button;
    for (let k = 0; k < count; k++) {
      i = nextIdx(i, eligible);
      t.seats[i]!.hole.push(deal(h));
    }
  }

  const sb = put(t.seats[sbSeat]!, SMALL_BLIND);
  h.actions.push({ street: "preflop", seat: sbSeat, type: "call", amount: sb, to: t.seats[sbSeat]!.bet });
  const bb = put(t.seats[bbSeat]!, BIG_BLIND);
  h.actions.push({ street: "preflop", seat: bbSeat, type: "call", amount: bb, to: t.seats[bbSeat]!.bet });

  h.toAct = canAct(t, firstToAct) ? firstToAct : nextIdx(firstToAct, (i) => canAct(t, i));
  progress(t);
  return true;
}

export function legalActions(t: TableState, seat: number): Legal | null {
  const h = t.hand;
  if (!h || h.street === "showdown" || h.toAct !== seat) return null;
  const s = t.seats[seat]!;
  const toCall = Math.max(0, h.currentBet - s.bet);
  const maxRaiseTo = s.bet + s.stack;
  const raiseRoom = s.canRaise && maxRaiseTo > h.currentBet;
  return {
    fold: true,
    check: toCall === 0,
    call: Math.min(toCall, s.stack),
    canRaise: raiseRoom,
    minRaiseTo: raiseRoom ? Math.min(h.currentBet + h.minRaise, maxRaiseTo) : 0,
    maxRaiseTo: raiseRoom ? maxRaiseTo : 0,
  };
}

/** Apply a player's action. Returns an error message, or null on success. */
export function act(t: TableState, seat: number, a: Action): string | null {
  const h = t.hand;
  const legal = legalActions(t, seat);
  if (!h || !legal) return "Not your turn";
  const s = t.seats[seat]!;
  let type = a.type;
  let to = a.to ?? 0;

  if (type === "allin") {
    to = s.bet + s.stack;
    // All-in is a raise only when raising is allowed; otherwise it calls (possibly for less)
    type = to > h.currentBet && legal.canRaise ? "raise" : "call";
  }

  switch (type) {
    case "fold":
      s.folded = true;
      h.actions.push({ street: h.street, seat, type, amount: 0, to: s.bet });
      break;
    case "check":
      if (!legal.check) return "Cannot check, there is a bet to call";
      h.actions.push({ street: h.street, seat, type, amount: 0, to: s.bet });
      break;
    case "call": {
      if (legal.call === 0) return "Nothing to call";
      const amt = put(s, legal.call);
      h.actions.push({ street: h.street, seat, type, amount: amt, to: s.bet });
      break;
    }
    case "raise": {
      if (!legal.canRaise) return "Raising is not allowed here";
      if (!Number.isInteger(to)) return "Raise amount must be a whole number";
      if (to > legal.maxRaiseTo) return "Not enough chips";
      if (to < legal.minRaiseTo) return `Minimum raise is to ${legal.minRaiseTo}`;
      const raiseSize = to - h.currentBet;
      const amt = put(s, to - s.bet);
      const full = raiseSize >= h.minRaise;
      if (full) h.minRaise = raiseSize;
      h.currentBet = to;
      for (let i = 0; i < n(); i++) {
        if (i === seat || !canAct(t, i)) continue;
        const o = t.seats[i]!;
        if (full) o.canRaise = true;
        else if (o.acted) o.canRaise = false; // short all-in does not re-open raising
        o.acted = false;
      }
      h.actions.push({ street: h.street, seat, type: s.allIn ? "allin" : "raise", amount: amt, to: s.bet });
      break;
    }
    default:
      return "Unknown action";
  }
  s.acted = true;
  s.timeouts = 0;
  progress(t);
  return null;
}

/** Called when a human runs out of time: check if free, otherwise fold. */
export function timeoutAction(t: TableState, seat: number): void {
  const legal = legalActions(t, seat);
  if (!legal) return;
  const s = t.seats[seat]!;
  act(t, seat, { type: legal.check ? "check" : "fold" });
  s.timeouts++;
}

function progress(t: TableState): void {
  const h = t.hand!;
  for (let guard = 0; ; guard++) {
    if (guard > 10) throw new Error("progress() did not settle");
    const active = t.seats.map((_, i) => i).filter((i) => isActive(t, i));
    if (active.length <= 1) return finish(t, "fold");

    const actors = active.filter((i) => canAct(t, i));
    const pending = actors.filter((i) => !t.seats[i]!.acted || t.seats[i]!.bet < h.currentBet);
    if (pending.length > 0) {
      if (!pending.includes(h.toAct)) h.toAct = nextIdx(h.toAct, (i) => pending.includes(i));
      return;
    }
    // Betting round complete
    if (h.street === "river") return finish(t, "showdown");
    nextStreet(t);
    // If at most one player can still bet, keep dealing to the river
    if (actors.length <= 1 || active.filter((i) => canAct(t, i)).length <= 1) {
      while ((h.street as Street) !== "river") nextStreet(t);
      return finish(t, "showdown");
    }
  }
}

function nextStreet(t: TableState): void {
  const h = t.hand!;
  for (const s of t.seats) {
    if (!s) continue;
    s.bet = 0;
    s.acted = false;
    s.canRaise = true;
  }
  h.currentBet = 0;
  h.minRaise = BIG_BLIND;
  h.ptr++; // burn
  if (h.street === "preflop") {
    h.board.push(deal(h), deal(h), deal(h));
    h.street = "flop";
  } else if (h.street === "flop") {
    h.board.push(deal(h));
    h.street = "turn";
  } else {
    h.board.push(deal(h));
    h.street = "river";
  }
  h.toAct = nextIdx(h.button, (i) => canAct(t, i));
}

export function buildPots(t: TableState): { amount: number; eligible: number[]; contributors: number }[] {
  const contrib = t.seats.map((s) => (s && s.inHand ? s.total : 0));
  const levels = [...new Set(contrib.filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: { amount: number; eligible: number[]; contributors: number }[] = [];
  let prev = 0;
  for (const lvl of levels) {
    let amount = 0;
    let contributors = 0;
    contrib.forEach((c) => {
      const part = Math.max(0, Math.min(c, lvl) - prev);
      if (part > 0) contributors++;
      amount += part;
    });
    let eligible = contrib.map((c, i) => i).filter((i) => isActive(t, i) && contrib[i] >= lvl);
    if (eligible.length === 0) eligible = t.seats.map((_, i) => i).filter((i) => isActive(t, i));
    const last = pots[pots.length - 1];
    // Merge levels with the same eligible players, but never merge an uncalled bet into a contested pot
    if (last && last.eligible.join() === eligible.join() && last.contributors >= 2 === contributors >= 2) {
      last.amount += amount;
      last.contributors = Math.max(last.contributors, contributors);
    } else pots.push({ amount, eligible, contributors });
    prev = lvl;
  }
  return pots;
}

function finish(t: TableState, endedBy: "fold" | "showdown"): void {
  const h = t.hand!;
  h.street = "showdown";
  h.toAct = -1;
  const pots = buildPots(t);

  // Rake: 5% of contested chips, capped, and only if a flop was dealt ("no flop, no drop")
  const contested = pots.filter((p) => p.contributors >= 2).reduce((a, p) => a + p.amount, 0);
  const rule = t.rake ?? DEFAULT_RAKE;
  const flopSeen = h.board.length >= 3 || !rule.noFlopNoDrop;
  let rake = flopSeen ? Math.min(Math.floor((contested * rule.percent) / 100), rule.cap) : 0;
  let rakeLeft = rake;

  const scores: Record<number, number> = {};
  const shown: HandResult["shown"] = {};
  const active = t.seats.map((_, i) => i).filter((i) => isActive(t, i));
  if (endedBy === "showdown") {
    for (const i of active) {
      const s = t.seats[i]!;
      scores[i] = bestScore([...s.hole, ...h.board]);
      shown[i] = { hole: s.hole, hand: categoryName(scores[i]) };
    }
  }

  const payouts = Array(n()).fill(0);
  const potResults: PotResult[] = [];
  for (const p of pots) {
    let amount = p.amount;
    if (p.contributors >= 2 && rakeLeft > 0) {
      const take = Math.min(rakeLeft, amount);
      amount -= take;
      rakeLeft -= take;
    }
    let winners: number[];
    if (p.eligible.length === 1 || endedBy === "fold") winners = p.eligible.length === 1 ? p.eligible : active;
    else {
      const best = Math.max(...p.eligible.map((i) => scores[i]));
      winners = p.eligible.filter((i) => scores[i] === best);
    }
    // Split; odd chips go to the first winner(s) clockwise from the button
    const ordered = winners.slice().sort((a, b) => ((a - h.button + n() - 1) % n()) - ((b - h.button + n() - 1) % n()));
    const share = Math.floor(amount / ordered.length);
    let rem = amount - share * ordered.length;
    for (const w of ordered) {
      payouts[w] += share + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
    }
    potResults.push({ amount: p.amount, eligible: p.eligible, winners: ordered });
  }
  rake -= rakeLeft;
  payouts.forEach((amt, i) => {
    if (amt > 0) t.seats[i]!.stack += amt;
  });
  for (const s of t.seats) if (s) s.bet = 0;
  h.result = { endedBy, pots: potResults, rake, payouts, shown };
}

/** Total chips in the middle this hand (for display). */
export function potTotal(t: TableState): number {
  return t.seats.reduce((a, s) => a + (s && s.inHand ? s.total : 0), 0);
}

/** Chips owned by the table: stacks plus anything committed to an unfinished hand. */
export function chipsOnTable(t: TableState): number {
  const inPlay = t.hand && !t.hand.result ? potTotal(t) : 0;
  return t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) + inPlay;
}

// ---------------------------------------------------------------------------
// Hand history and replay verification
// ---------------------------------------------------------------------------
export interface HandHistory {
  tableId: string;
  handNo: number;
  prevButton: number;
  startSeats: Hand["startSeats"];
  deck: string[];
  salts: string[];
  commit: string;
  actions: ActionRecord[];
  board: string[];
  result: HandResult;
  endedAt: number;
}

export function historyOf(tableId: string, t: TableState): HandHistory {
  const h = t.hand!;
  return {
    tableId, handNo: h.no, prevButton: h.prevButton, startSeats: h.startSeats,
    deck: h.deck, salts: h.salts, commit: h.commit, actions: h.actions,
    board: h.board, result: h.result!, endedAt: Date.now(),
  };
}

/** Re-run a hand from its history with the same rules engine. Returns the recomputed result. */
export function replayHand(hist: HandHistory): HandResult {
  const t = newTable();
  t.seats = hist.startSeats.map((s) => (s ? newSeat(s.userId, s.name, s.isBot, s.stack, "replay") : null));
  t.button = hist.prevButton;
  t.handNo = hist.handNo - 1;
  startHand(t, hist.deck, hist.salts, hist.commit);
  // The first two recorded actions are the blinds, posted by startHand
  for (const a of hist.actions.slice(2)) {
    const type: ActionType = a.type === "allin" ? "allin" : a.type;
    const err = act(t, a.seat, type === "raise" ? { type, to: a.to } : { type });
    if (err) throw new Error(`Replay diverged at ${JSON.stringify(a)}: ${err}`);
  }
  if (!t.hand?.result) throw new Error("Replay did not finish the hand");
  return t.hand.result;
}
