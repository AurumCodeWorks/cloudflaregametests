// Preview states for /?demo=turn and /?demo=showdown (no server needed).
async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

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
    // deck order consistent with the deal: holes, burn, flop, burn, turn, burn, river
    const deck = ["Qs", "8s", "9d", "Ah", "Qd", "4s", "3c", "Kh", "5c", "Qh", "7c", "Jh", "6h", "2d", "9c", "Th"];
    const rest = "23456789TJQKA".split("").flatMap((r) => "cdhs".split("").map((x) => r + x)).filter((c) => !deck.includes(c));
    const full = deck.concat(rest);
    const salts = full.map((_, i) => (i * 2654435761 >>> 0).toString(16));
    const leaves = await Promise.all(full.map((c, i) => sha256Hex(`${c}:${salts[i]}`)));
    const commit = await sha256Hex(leaves.join(","));
    const visible = new Set([...fullBoard, "Ah", "Kh", "Qs", "Qd"]);
    const reveal = full.map((c, i) => (visible.has(c) ? { card: c, salt: salts[i] } : { leaf: leaves[i] }));
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
