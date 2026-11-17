// The slot machines: published reel strips and paytables, and the one function that turns reel stops
// into a payout. Shared by the server (which pays), the browser (which draws the reels, shows the
// paytable and re-checks every spin) and the Node tests (which prove the return to player).
//
// Honest by construction:
//   - every stop on a reel is equally likely (see spinStops in fair.js); there are no hidden weights
//     and no "virtual reels": the strips below are exactly what is spun and exactly what is drawn
//   - the payout depends only on the stops, never on the player, their history or their cosmetics
//   - the return to player is computed exactly by going through every combination of stops (exactRtp)

/**
 * Play-money stakes per spin, in pence: 10p, 20p, 50p, £1, £2, £5 (100 play chips = £1, so one chip is a penny
 * and every payout is a whole number of chips at every stake). Capped at £5, as UK online slots are.
 * A win is always the paytable multiple of the stake, so it scales exactly with what was staked.
 */
export const STAKES = [10, 20, 50, 100, 200, 500];
/** Pence as money: 10 -> "10p", 100 -> "£1", 250 -> "£2.50", 125000 -> "£1,250". */
export function formatMoney(pence) {
  const p = Math.abs(pence);
  if (p < 100) return `${p}p`;
  return `£${(p / 100).toLocaleString("en-GB", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
/** UK rules: at least 2.5 seconds from the start of one spin to the start of the next. Enforced by the server too. */
export const MIN_SPIN_MS = 2500;

const SEVENS_PAYS = [
  { key: "777", label: "Three sevens", show: ["7", "7", "7"], mult: 200 },
  { key: "B3", label: "Three triple bars", show: ["B3", "B3", "B3"], mult: 60 },
  { key: "B2", label: "Three double bars", show: ["B2", "B2", "B2"], mult: 40 },
  { key: "B1", label: "Three single bars", show: ["B1", "B1", "B1"], mult: 20 },
  { key: "BELL", label: "Three bells", show: ["BELL", "BELL", "BELL"], mult: 16 },
  { key: "PLUM", label: "Three plums", show: ["PLUM", "PLUM", "PLUM"], mult: 12 },
  { key: "ORANGE", label: "Three oranges", show: ["ORANGE", "ORANGE", "ORANGE"], mult: 10 },
  { key: "LEMON", label: "Three lemons", show: ["LEMON", "LEMON", "LEMON"], mult: 8 },
  { key: "CHERRY", label: "Three cherries", show: ["CHERRY", "CHERRY", "CHERRY"], mult: 8 },
  { key: "ANYBAR", label: "Any mix of three bars", show: ["B1", "B2", "B3"], mult: 5 },
  { key: "CHERRY2", label: "Cherries on reels 1 and 2", show: ["CHERRY", "CHERRY", "ANY"], mult: 4 },
  { key: "CHERRY1", label: "Cherry on reel 1", show: ["CHERRY", "ANY", "ANY"], mult: 2 },
];
const ROYAL_PAYS = [
  { key: "royal", label: "Royal flush", mult: 2500, example: ["Ts", "Js", "Qs", "Ks", "As"] },
  { key: "straightflush", label: "Straight flush", mult: 500, example: ["5h", "6h", "7h", "8h", "9h"] },
  { key: "quads", label: "Four of a kind", mult: 150, example: ["9c", "9d", "9h", "9s", "Kd"] },
  { key: "fullhouse", label: "Full house", mult: 40, example: ["Qc", "Qd", "Qh", "4s", "4d"] },
  { key: "flush", label: "Flush", mult: 20, example: ["2d", "7d", "9d", "Jd", "Kd"] },
  { key: "straight", label: "Straight", mult: 15, example: ["6c", "7d", "8h", "9s", "Tc"] },
  { key: "trips", label: "Three of a kind", mult: 6, example: ["8c", "8d", "8h", "Ks", "3d"] },
  { key: "twopair", label: "Two pair", mult: 3, example: ["Jc", "Jd", "5h", "5s", "Ad"] },
  { key: "jacks", label: "Pair of jacks or better", mult: 1, example: ["Kc", "Kd", "7h", "4s", "2d"] },
];

export const MACHINES = {
  sevens: {
    id: "sevens", name: "Lucky Sevens", kind: "classic", rows: 3,
    blurb: "Three reels, one win line. Fruit, bars, bells and sevens.",
    // 24 stops per reel; the win line is the middle row
    reels: [
      ["LEMON", "B1", "B2", "B3", "ORANGE", "LEMON", "CHERRY", "B1", "7", "PLUM", "LEMON", "CHERRY", "B2", "B3", "LEMON", "B1", "ORANGE", "CHERRY", "B2", "LEMON", "7", "PLUM", "BELL", "CHERRY"],
      ["LEMON", "B1", "7", "CHERRY", "B2", "LEMON", "B3", "B1", "PLUM", "BELL", "LEMON", "B3", "B2", "PLUM", "LEMON", "B1", "B2", "B3", "7", "LEMON", "PLUM", "ORANGE", "B2", "B3"],
      ["B2", "LEMON", "CHERRY", "PLUM", "ORANGE", "B2", "LEMON", "BELL", "B1", "7", "B2", "LEMON", "ORANGE", "CHERRY", "B2", "LEMON", "ORANGE", "BELL", "B3", "B2", "LEMON", "B1", "ORANGE", "BELL"],
    ],
    pays: SEVENS_PAYS,
  },
  royal: {
    id: "royal", name: "Royal Reels", kind: "cards", rows: 3,
    blurb: "One deck dealt across five reels. The middle row pays as a poker hand.",
    // The 52 cards of one deck, each on exactly one reel, so a spin always shows five different cards
    reels: [
      ["Kh", "Qd", "7h", "6c", "Jd", "2s", "8h", "As", "8s", "Ac", "9c"],
      ["Jh", "Ks", "9s", "Ts", "4s", "6d", "8c", "Ad", "5d", "3c", "Qc"],
      ["8d", "3h", "9h", "Qh", "Kc", "Td", "2c", "6s", "5h", "7c"],
      ["Js", "9d", "3d", "7s", "4c", "4h", "2h", "Ah", "Tc", "5s"],
      ["3s", "Th", "5c", "6h", "Jc", "2d", "Kd", "7d", "Qs", "4d"],
    ],
    pays: ROYAL_PAYS,
  },
};
export const MACHINE_IDS = Object.keys(MACHINES);
export const reelSizes = (id) => MACHINES[id].reels.map((r) => r.length);
/** The symbols on the win line for these stops. */
export const lineOf = (id, stops) => MACHINES[id].reels.map((r, i) => r[stops[i]]);

const isBar = (s) => s === "B1" || s === "B2" || s === "B3";
function sevensLine([a, b, c]) {
  if (a === b && b === c) return { key: a === "7" ? "777" : a, cells: [0, 1, 2] };
  if (isBar(a) && isBar(b) && isBar(c)) return { key: "ANYBAR", cells: [0, 1, 2] };
  if (a === "CHERRY" && b === "CHERRY") return { key: "CHERRY2", cells: [0, 1] };
  if (a === "CHERRY") return { key: "CHERRY1", cells: [0] };
  return null;
}

const RANKS = "23456789TJQKA";
/** The best poker hand made by five different cards, and which of them make it. */
function pokerLine(cards) {
  const ranks = cards.map((c) => RANKS.indexOf(c[0]));
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const groups = {}; // rank -> positions
  ranks.forEach((r, i) => (groups[r] ??= []).push(i));
  const sets = Object.values(groups).sort((x, y) => y.length - x.length);
  const all = [0, 1, 2, 3, 4];
  if (sets.length === 5) {
    const sorted = [...ranks].sort((x, y) => x - y);
    const straight = sorted[4] - sorted[0] === 4 || sorted.join() === "0,1,2,3,12"; // A-2-3-4-5 counts
    if (straight && flush) return { key: sorted[0] === 8 ? "royal" : "straightflush", cells: all };
    if (flush) return { key: "flush", cells: all };
    if (straight) return { key: "straight", cells: all };
    return null;
  }
  if (sets[0].length === 4) return { key: "quads", cells: sets[0] };
  if (sets[0].length === 3 && sets[1].length === 2) return { key: "fullhouse", cells: all };
  if (sets[0].length === 3) return { key: "trips", cells: sets[0] };
  if (sets[1].length === 2) return { key: "twopair", cells: [...sets[0], ...sets[1]].sort() };
  return ranks[sets[0][0]] >= RANKS.indexOf("J") ? { key: "jacks", cells: sets[0] } : null;
}

/**
 * What these stops pay: `mult` times the stake (0 for nothing), the paytable line that won, and
 * which reels hold the winning symbols.
 */
export function evaluate(id, stops) {
  const m = MACHINES[id];
  const line = lineOf(id, stops);
  const hit = m.kind === "classic" ? sevensLine(line) : pokerLine(line);
  if (!hit) return { mult: 0, key: null, label: null, cells: [], line };
  const pay = m.pays.find((p) => p.key === hit.key);
  return { mult: pay.mult, key: pay.key, label: pay.label, cells: hit.cells, line };
}

/**
 * The exact return to player, by enumerating every combination of reel stops (each equally likely).
 * Returns whole-number totals so the result is exact: rtp = totalMult / combos.
 */
export function exactRtp(id) {
  const sizes = reelSizes(id);
  const combos = sizes.reduce((a, n) => a * n, 1);
  const lines = {};
  let totalMult = 0, totalSq = 0, paying = 0, winning = 0, maxMult = 0;
  const stops = sizes.map(() => 0);
  for (let n = 0; n < combos; n++) {
    const r = evaluate(id, stops);
    if (r.mult) {
      totalMult += r.mult;
      totalSq += r.mult * r.mult;
      paying++;
      if (r.mult > 1) winning++;
      if (r.mult > maxMult) maxMult = r.mult;
      (lines[r.key] ??= { count: 0, mult: r.mult }).count++;
    }
    for (let i = sizes.length - 1; i >= 0; i--) { if (++stops[i] < sizes[i]) break; stops[i] = 0; } // next combination
  }
  const rtp = totalMult / combos;
  return {
    combos, totalMult, rtp, lines, maxMult,
    anyReturn: paying / combos, // chance a spin returns anything
    winRate: winning / combos, // chance a spin returns MORE than the stake (a real win)
    variance: totalSq / combos - rtp * rtp, // of the return per 1 staked
  };
}

/**
 * How a result may be presented. A return of the stake or less is NOT a win: no win sound, no
 * celebration (UK RTS 14F, "losses disguised as wins"). Real wins scale with their size.
 */
export function celebrationTier(stake, payout) {
  if (!(payout > stake)) return "none";
  const x = payout / stake;
  return x >= 40 ? "big" : x >= 8 ? "medium" : "small";
}
