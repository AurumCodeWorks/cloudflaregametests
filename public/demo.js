// Preview states for /?demo=turn and /?demo=showdown (no server needed).
import { sha256Hex } from "./fair.js";

const seats = () => [
  { name: "Sam", isBot: false, you: true, stack: 410, bet: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["Ah", "Kh"] },
  { name: "Ada (bot)", isBot: true, stack: 655, bet: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["??", "??"] },
  { name: "Jordan", isBot: false, stack: 280, bet: 0, folded: true, allIn: false, inHand: true, connected: true, hole: [] },
  { name: "Turing (bot)", isBot: true, stack: 390, bet: 60, folded: false, allIn: false, inHand: true, connected: true, hole: ["??", "??"] },
];

export async function demoState(kind) {
  const board = ["Qh", "7c", "Jh", "2d"];
  if (kind === "showdown") {
    const fullBoard = [...board, "Th"];
    const s = seats();
    s[0].hole = ["Ah", "Kh"];
    s[0].stack = 600;
    s[1].hole = ["Qs", "Qd"];
    s[3].hole = ["??", "??"];
    s[3].folded = true;
    s[3].bet = 0;
    s[3].hole = [];
    s[1].stack = 555;
    const { commit, reveal } = await proof([...fullBoard, "Ah", "Kh", "Qs", "Qd"]);
    return {
      type: "state", tableId: "t-demo", turnSeconds: 20, wallet: 500,
      you: { seat: 0, waiting: false },
      seats: s,
      hand: {
        no: 42, street: "showdown", board: fullBoard, pot: 410, currentBet: 0, toAct: -1, button: 2, commit, deadline: null,
        result: {
          endedBy: "showdown", rake: 20,
          pots: [{ amount: 410, eligible: [0, 1], winners: [0] }],
          payouts: [390, 0, 0, 0],
          shown: { 0: { hole: ["Ah", "Kh"], hand: "Straight flush" }, 1: { hole: ["Qs", "Qd"], hand: "Three of a kind" } },
        },
        reveal,
      },
      legal: null,
      log: [
        "Hand #42 — deck fingerprint 9f3c21a7b04e…",
        "Turing (bot) bets 60",
        "Sam calls 60",
        "Ada (bot) calls 60",
        "River: T♥",
        "Ada (bot) checks · Sam bets 150 · Ada (bot) calls",
        "Sam wins 390 with a straight flush (rake 20)",
      ],
    };
  }
  // "turn": it's your move on the turn
  return {
    type: "state", tableId: "t-demo", turnSeconds: 20, wallet: 500,
    you: { seat: 0, waiting: false },
    seats: seats(),
    hand: {
      no: 42, street: "turn", board, pot: 230, currentBet: 60, toAct: 0, button: 2,
      commit: "9f3c21a7b04e5d8812aa0c4f7e61b3d29c0f8e5a1b7d6c3e2f4a5b6c7d8e9f01",
      deadline: Date.now() + 14000, result: null, reveal: null,
    },
    legal: { fold: true, check: false, call: 60, canRaise: true, minRaiseTo: 120, maxRaiseTo: 410 },
    log: [
      "Hand #42 — deck fingerprint 9f3c21a7b04e…",
      "Blinds 5/10 · Jordan is the dealer",
      "Ada (bot) raises to 30 · Jordan folds",
      "Flop: Q♥ 7♣ J♥",
      "Turn: 2♦",
      "Turing (bot) bets 60",
    ],
  };
}

// ---------------------------------------------------------------------------
// /?demo=play: a full scripted hand (deal, three betting rounds, folds, showdown)
// so every animation can be seen with the real renderer.
// ---------------------------------------------------------------------------
async function proof(visibleCards) {
  // Deck order follows the real deal with the button on seat 2: hole cards to seats 3, 0, 1, 2 (twice),
  // then burn + flop, burn + turn, burn + river
  const deck = ["9d", "Ah", "Qs", "8s", "4s", "Kh", "Qd", "3c", "5c", "Qh", "7c", "Jh", "6h", "2d", "9c", "Th"];
  const rest = "23456789TJQKA".split("").flatMap((r) => "cdhs".split("").map((x) => r + x)).filter((c) => !deck.includes(c));
  const full = deck.concat(rest);
  const salts = full.map((_, i) => ((i + 7) * 2654435761 >>> 0).toString(16));
  const leaves = await Promise.all(full.map((c, i) => sha256Hex(`${c}:${salts[i]}`)));
  const commit = await sha256Hex(leaves.join(","));
  const reveal = full.map((c, i) => (visibleCards.includes(c) ? { card: c, salt: salts[i] } : { leaf: leaves[i] }));
  return { commit, reveal };
}

export async function demoSequence() {
  const { commit, reveal } = await proof(["Qh", "7c", "Jh", "2d", "Th", "Ah", "Kh", "Qs", "Qd"]);
  const seats = [
    { name: "Sam", isBot: false, you: true, stack: 500, bet: 0, total: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["Ah", "Kh"] },
    { name: "Ada (bot)", isBot: true, stack: 700, bet: 0, total: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["??", "??"] },
    { name: "Jordan", isBot: false, stack: 280, bet: 0, total: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["??", "??"] },
    { name: "Turing (bot)", isBot: true, stack: 480, bet: 0, total: 0, folded: false, allIn: false, inHand: true, connected: true, hole: ["??", "??"] },
  ];
  const hand = { no: 42, street: "preflop", board: [], pot: 0, currentBet: 0, toAct: 1, button: 2, commit, deadline: null, result: null, reveal: null };
  const log = [`Hand #42 — deck fingerprint ${commit.slice(0, 12)}…`, "Blinds 5/10 · Jordan is the dealer"];
  let legal = null;
  const steps = [];
  const snap = (wait) => {
    hand.pot = seats.reduce((a, s) => a + s.total, 0);
    steps.push({
      wait,
      state: {
        type: "state", tableId: "t-demo", turnSeconds: 20, wallet: 500, you: { seat: 0, waiting: false },
        seats: seats.map((s) => ({ ...s, hole: [...s.hole] })),
        hand: { ...hand, board: [...hand.board], deadline: hand.toAct === 0 ? Date.now() + 20000 + steps.reduce((a, s) => a + s.wait, 0) + wait : null },
        legal, log: log.slice(-10),
      },
    });
  };
  const put = (i, to) => { const s = seats[i]; const amt = to - s.bet; s.stack -= amt; s.bet = to; s.total += amt; hand.currentBet = Math.max(hand.currentBet, to); };
  const street = (name, cards) => { seats.forEach((s) => (s.bet = 0)); hand.currentBet = 0; hand.street = name; hand.board.push(...cards); log.push(`${name[0].toUpperCase() + name.slice(1)}: ${cards.map((c) => (c[0] === "T" ? "10" : c[0]) + { h: "♥", d: "♦", c: "♣", s: "♠" }[c[1]]).join(" ")}`); };

  put(3, 5); put(0, 10); hand.toAct = 1; snap(400);
  put(1, 30); log.push("Ada (bot) raises to 30"); hand.toAct = 2; snap(1700);
  seats[2].folded = true; seats[2].hole = []; log.push("Jordan folds"); hand.toAct = 3; snap(1100);
  put(3, 30); log.push("Turing (bot) calls 30"); hand.toAct = 0; legal = { fold: true, check: false, call: 20, canRaise: true, minRaiseTo: 50, maxRaiseTo: 490 }; snap(1100);
  legal = null; put(0, 30); log.push("Sam calls 20"); street("flop", ["Qh", "7c", "Jh"]); hand.toAct = 3; snap(1900);
  put(3, 60); log.push("Turing (bot) bets 60"); hand.toAct = 0; legal = { fold: true, check: false, call: 60, canRaise: true, minRaiseTo: 120, maxRaiseTo: 470 }; snap(1900);
  legal = null; put(0, 60); log.push("Sam calls 60"); hand.toAct = 1; snap(1500);
  put(1, 60); log.push("Ada (bot) calls 60"); street("turn", ["2d"]); hand.toAct = 3; snap(1300);
  log.push("Turing (bot) checks"); hand.toAct = 0; legal = { fold: true, check: true, call: 0, canRaise: true, minRaiseTo: 10, maxRaiseTo: 410 }; snap(1700);
  legal = null; put(0, 70); log.push("Sam bets 70"); hand.toAct = 1; snap(1500);
  put(1, 70); log.push("Ada (bot) calls 70"); hand.toAct = 3; snap(1200);
  seats[3].folded = true; seats[3].hole = []; log.push("Turing (bot) folds"); street("river", ["Th"]); hand.toAct = 0; legal = { fold: true, check: true, call: 0, canRaise: true, minRaiseTo: 10, maxRaiseTo: 340 }; snap(1300);
  legal = null; log.push("Sam checks"); hand.toAct = 1; snap(1500);
  // Showdown
  log.push("Ada (bot) checks", "Sam wins 390 with a straight flush (rake 20)");
  seats.forEach((s) => (s.bet = 0));
  seats[1].hole = ["Qs", "Qd"];
  seats[0].stack += 390;
  hand.street = "showdown"; hand.toAct = -1;
  hand.result = {
    endedBy: "showdown", rake: 20, pots: [{ amount: 410, eligible: [0, 1], winners: [0] }], payouts: [390, 0, 0, 0],
    shown: { 0: { hole: ["Ah", "Kh"], hand: "Straight flush" }, 1: { hole: ["Qs", "Qd"], hand: "Three of a kind" } },
  };
  hand.reveal = reveal;
  snap(1300);
  return steps;
}
