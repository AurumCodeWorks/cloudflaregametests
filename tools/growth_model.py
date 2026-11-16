#!/usr/bin/env python3
"""
Light-advertising growth model, month by month for 24 months.
Run: python3 tools/growth_model.py      (all inputs are assumptions you can change)
"""
NET_PER_PLAYER_MONTH = 12.23 * (1 - 0.40 - 0.10)  # £12.23 house fees at 8 h/month, after 40% duty + 10% payments
KYC = 1.50                 # per new player
CPA = 40.0                 # ad cost per new real-money player (poker sits at the low end of £25-£600)
CHURN = 0.12               # share of players who stop each month
FIXED = 1_000.0            # licence (£583/m), Cloudflare (~£50), KYC/GAMSTOP/compliance tooling
START_PLAYERS = 50         # friends, early community, free-play regulars who convert at launch
ONE_OFF = 8_185 + 20_000   # UKGC application [researched] + testing/legal (rough estimate)

def run(ad_budget, word_of_mouth, months=24):
    players, cash, rows, breakeven = START_PLAYERS, -ONE_OFF, [], None
    for m in range(1, months + 1):
        new = ad_budget / CPA + players * word_of_mouth
        players = players * (1 - CHURN) + new
        profit = players * NET_PER_PLAYER_MONTH - new * KYC - FIXED - ad_budget
        cash += profit
        if breakeven is None and cash >= 0: breakeven = m
        rows.append((m, players, profit, cash))
    return rows, breakeven

def gbp(x): return f"£{x:,.0f}" if x >= 0 else f"-£{-x:,.0f}"

print(f"Each real-money player nets ~£{NET_PER_PLAYER_MONTH:.2f}/month after tax and payments. "
      f"{int(CHURN*100)}% leave each month. Start-up costs {gbp(ONE_OFF)}.\n")
print(f"{'ads/month':>10} {'word of mouth':>14} | {'players m6':>10} {'m12':>6} {'m24':>6} | {'profit/mo m12':>13} {'m24':>8} | {'cash after 24m':>14} {'paid back':>10}")
for ads in (500, 1_000, 2_000):
    for wom, label in ((0.03, "low"), (0.06, "medium"), (0.10, "strong")):
        rows, be = run(ads, wom)
        p = {m: (pl, pr, c) for m, pl, pr, c in rows}
        print(f"{gbp(ads):>10} {label + f' ({wom:.0%})':>14} | {p[6][0]:>10,.0f} {p[12][0]:>6,.0f} {p[24][0]:>6,.0f} | "
              f"{gbp(p[12][1]):>13} {gbp(p[24][1]):>8} | {gbp(p[24][2]):>14} {('month ' + str(be)) if be else 'not yet':>10}")
print("\n'Word of mouth' = new players each month brought in per existing player (friends tables, referrals, free-play conversions).")
print(f"Long-run player count = (ad players + word-of-mouth) / churn. Profit covers fixed costs from ~{FIXED / NET_PER_PLAYER_MONTH:,.0f} players.")
