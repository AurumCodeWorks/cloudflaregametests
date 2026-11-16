// Stake levels. The house earns ONLY through these disclosed fees:
//  - Sit & Go: a fee added to the buy-in ("£5 + £0.45"); the whole buy-in goes to the prize pool,
//    and the table plays with 0% rake.
//  - Cash tables: a percentage of each contested pot, capped, with no rake if there is no flop.
// Fee levels follow typical online poker practice (Sit & Go fees ~7-10%, cash rake ~5% capped),
// with lower percentages at higher stakes. Amounts are in pence to avoid rounding errors.
import type { RakeRule } from "./holdem.ts";

export interface StakeTier {
  id: string;
  name: string;
  sitAndGo: { buyInPence: number; feePence: number; seats: number; payouts: number[] };
  cash: { smallBlindPence: number; bigBlindPence: number; buyInPence: number; rake: RakeRule };
}

const pct = (fee: number, buyIn: number) => Math.round((fee / buyIn) * 1000) / 10;

export const STAKES: StakeTier[] = [
  {
    id: "micro", name: "Micro",
    sitAndGo: { buyInPence: 100, feePence: 10, seats: 4, payouts: [65, 35] },
    cash: { smallBlindPence: 1, bigBlindPence: 2, buyInPence: 200, rake: { percent: 5, cap: 10, noFlopNoDrop: true } },
  },
  {
    id: "low", name: "Low",
    sitAndGo: { buyInPence: 500, feePence: 45, seats: 4, payouts: [65, 35] },
    cash: { smallBlindPence: 5, bigBlindPence: 10, buyInPence: 1000, rake: { percent: 5, cap: 30, noFlopNoDrop: true } },
  },
  {
    id: "mid", name: "Mid",
    sitAndGo: { buyInPence: 1000, feePence: 80, seats: 4, payouts: [65, 35] },
    cash: { smallBlindPence: 10, bigBlindPence: 20, buyInPence: 2000, rake: { percent: 5, cap: 60, noFlopNoDrop: true } },
  },
  {
    id: "high", name: "High",
    sitAndGo: { buyInPence: 2500, feePence: 188, seats: 4, payouts: [65, 35] },
    cash: { smallBlindPence: 25, bigBlindPence: 50, buyInPence: 5000, rake: { percent: 4.5, cap: 100, noFlopNoDrop: true } },
  },
  {
    id: "vip", name: "VIP",
    sitAndGo: { buyInPence: 10000, feePence: 600, seats: 4, payouts: [65, 35] },
    cash: { smallBlindPence: 100, bigBlindPence: 200, buyInPence: 20000, rake: { percent: 4, cap: 300, noFlopNoDrop: true } },
  },
];

/** Tournament tables take no rake: the house's fee was charged once, at entry. */
export const TOURNAMENT_RAKE: RakeRule = { percent: 0, cap: 0, noFlopNoDrop: true };

/** Plain-English fee disclosure shown to players before they join. */
export function disclose(t: StakeTier): { sitAndGo: string; cash: string } {
  const s = t.sitAndGo;
  const c = t.cash;
  const money = (p: number) => `£${(p / 100).toFixed(2).replace(/\.00$/, "")}`;
  return {
    sitAndGo: `${money(s.buyInPence)} + ${money(s.feePence)} fee (${pct(s.feePence, s.buyInPence)}%). The full ${money(s.buyInPence)} from every player goes to the prize pool; top ${s.payouts.length} paid ${s.payouts.join("/")}%.`,
    cash: `Blinds ${money(c.smallBlindPence)}/${money(c.bigBlindPence)}. House fee ${c.rake.percent}% of each pot that sees a flop, capped at ${money(c.rake.cap)}. No flop, no fee.`,
  };
}
