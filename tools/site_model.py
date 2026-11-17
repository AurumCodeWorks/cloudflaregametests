#!/usr/bin/env python3
"""
Whole-site model: what poker + slots could earn as a licensed UK real-money site, and what Cloudflare hosting costs.
Run:  python3 tools/site_model.py
Every input is an assumption you can change. [R] = researched figure, [M] = measured on our own code.
"""

USD_TO_GBP = 0.78  # assumption; Cloudflare bills in dollars

# ================================================================ Cloudflare prices (Workers Paid plan) [R]
BASE = 5.00
PRICES = {  # unit: (included per month, $ per unit above that)
    "worker_req":   (10e6, 0.30 / 1e6),
    "do_req":       (1e6, 0.15 / 1e6),
    "do_gbs":       (400e3, 12.50 / 1e6),   # Durable Object duration, GB-seconds at 128 MB
    "do_rows_w":    (50e6, 1.00 / 1e6),     # Durable Object SQLite storage, rows written
    "d1_rows_w":    (50e6, 1.00 / 1e6),
    "r2_class_a":   (1e6, 4.50 / 1e6),
    "r2_gb_month":  (10, 0.015),
}

# ================================================================ usage per unit of play
# Poker: a table Durable Object is treated as awake the whole time people sit at it (bots act and timers fire every
# second or two, so it rarely hibernates): 0.125 GB x 3600 s. Real usage is lower; this is the cautious figure.
HUMANS_PER_TABLE = 3          # bots fill the other seats
HANDS_PER_TABLE_HOUR = 70
PER_TABLE_HOUR = {
    "do_gbs": 0.125 * 3600,
    "do_req": 1000 + 150,                      # alarms (bot moves, turn timers, next hand) + billed WebSocket messages (20:1)
    "do_rows_w": 2000,                         # the table saving its state after each event
    "d1_rows_w": HANDS_PER_TABLE_HOUR * 7 + 50,  # 7 rows per ledger transfer [M]: the rake each hand, plus buy-ins/cash-outs
    "r2_class_a": HANDS_PER_TABLE_HOUR,         # one hand history per hand
}
HAND_HISTORY_KB = 4                            # [M] roughly, from the R2 bucket

# Slots: plain requests, one Durable Object per player that sleeps between spins [M: "no sockets, no alarms"].
SPINS_PER_HOUR = 440            # [R] UK online slots average ~125 spins in a ~17 minute session
WIN_SHARE = 0.30                # share of spins that pay something (needs a payout transfer)
PER_SLOT_HOUR = {
    "worker_req": SPINS_PER_HOUR,
    "do_req": SPINS_PER_HOUR,
    "do_gbs": SPINS_PER_HOUR * 0.05 * 0.125,          # ~50 ms awake per spin
    "do_rows_w": SPINS_PER_HOUR * 2,                   # spin saved before the transfers, then marked done
    "d1_rows_w": SPINS_PER_HOUR * (7 + WIN_SHARE * 7 + 1),  # stake transfer, payout transfer, audit row
}
PAGE_REQUESTS_PER_PLAYER_HOUR = 30   # page, scripts, styles, API calls (the client is bundled into the Worker)


def hosting(poker_player_hours, slot_player_hours, months_of_history=12):
    use = {k: 0.0 for k in PRICES}
    table_hours = poker_player_hours / HUMANS_PER_TABLE
    for k, v in PER_TABLE_HOUR.items(): use[k] += v * table_hours
    for k, v in PER_SLOT_HOUR.items(): use[k] += v * slot_player_hours
    use["worker_req"] += PAGE_REQUESTS_PER_PLAYER_HOUR * (poker_player_hours + slot_player_hours)
    use["r2_gb_month"] = table_hours * HANDS_PER_TABLE_HOUR * HAND_HISTORY_KB / 1e6 * months_of_history
    lines = {k: max(0.0, use[k] - inc) * price for k, (inc, price) in PRICES.items()}
    return BASE + sum(lines.values()), lines


def gbp(x): return f"£{x:,.0f}" if x >= 0 else f"-£{-x:,.0f}"


# ================================================================ 1. hosting by how busy the site is
print("1) CLOUDFLARE HOSTING by people online at once (average over the month, half poker, half slots)")
print(f"{'online':>8}{'player-hours/mo':>17}{'$/month':>10}{'£/month':>10}   biggest line")
for online in (10, 30, 100, 300, 1000, 3000):
    ph = online * 720
    usd, lines = hosting(ph / 2, ph / 2)
    top = max(lines, key=lines.get)
    print(f"{online:>8,}{ph:>17,.0f}{usd:>10,.0f}{usd * USD_TO_GBP:>10,.0f}   {top if lines[top] > 0 else '(all inside the included amounts)'}")
_, l = hosting(100 * 360, 100 * 360)
print("   At 100 online the bill is: " + ", ".join(f"{k} ${v:,.0f}" for k, v in l.items() if v >= 1) + " + $5 plan")
print(f"   Per player-hour: poker ${hosting(1e6, 0)[0] / 1e6:.4f}, slots ${hosting(0, 1e6)[0] / 1e6:.4f} (marginal, at scale)")

# ================================================================ 2. real-money earnings (hypothetical, licensed)
POKER_GGY_PER_HOUR = 1.53     # house fee per player-hour (tools/earnings_model.py: 2.5 entries/h x £0.61 blended fee)
POKER_HOURS = 8               # per poker player per month
SLOT_GGY_PER_SESSION = 3.70   # [R] UKGC: online slots GGY ~£746m/quarter over ~200m sessions
SLOT_SESSIONS = 10            # per slots player per month
SLOT_SESSION_HOURS = 17 / 60  # [R] average session ~17 minutes

DUTY = 0.40                   # [R] Remote Gaming Duty from April 2026
PAYMENTS = 0.10               # of GGY: gambling-approved payment processing (assumption)
NEW_SHARE = 0.15              # share of each month's players who are new, = monthly churn at a steady size (assumption)
CPA = 100.0                   # cost to acquire a depositing player (UK range £25-£600 [R]; casino sits higher than poker)
KYC = 1.50                    # identity and age checks per new player
LICENCE_YEAR = [(250_000, 7_000), (875_000, 12_375)]  # [R] UKGC remote casino annual fee by GGY band
STAFF_COMPLIANCE = 6_000      # per month: a licensed key person/MLRO, support cover, tooling (assumption)

SCENARIOS = [  # name, poker players/month, slots players/month
    ("Launch", 300, 300),
    ("Target", 1_500, 750),
    ("Busy", 5_000, 2_000),
]

print("\n2) IF IT WERE A LICENSED REAL-MONEY SITE (per month)")
hdr = ["", "poker GGY", "slots GGY", "duty 40%", "payments", "KYC", "licence", "staff", "hosting", "pre-ads", "marketing", "= profit"]
print(f"{hdr[0]:<8}" + "".join(f"{h:>10}" for h in hdr[1:]) + "  online")
for name, poker, slots in SCENARIOS:
    p_ggy = poker * POKER_HOURS * POKER_GGY_PER_HOUR
    s_ggy = slots * SLOT_SESSIONS * SLOT_GGY_PER_SESSION
    ggy = p_ggy + s_ggy
    new = (poker + slots) * NEW_SHARE
    lic = next((fee for cap, fee in LICENCE_YEAR if ggy * 12 < cap), None)
    lic_m = (lic or LICENCE_YEAR[-1][1]) / 12  # at least the top band modelled
    ph_p, ph_s = poker * POKER_HOURS, slots * SLOT_SESSIONS * SLOT_SESSION_HOURS
    host = hosting(ph_p, ph_s)[0] * USD_TO_GBP
    costs = [ggy * DUTY, ggy * PAYMENTS, new * KYC, lic_m, STAFF_COMPLIANCE, host]
    pre_ads = ggy - sum(costs)
    profit = pre_ads - new * CPA
    cells = [gbp(p_ggy), gbp(s_ggy)] + [gbp(c) for c in costs[:3]] + [gbp(lic_m) + ("" if lic else "*"), gbp(costs[4]), gbp(host), gbp(pre_ads), gbp(new * CPA), gbp(profit)]
    print(f"{name:<8}" + "".join(f"{c:>10}" for c in cells) + f"  {(ph_p + ph_s) / 720:>6.0f}")
print("   * GGY above £875k/year moves to a higher UKGC fee band; shown at the £12,375 band as a floor.")

print("\n   Same scenarios with cheaper players (CPA), profit per month:")
for cpa in (0, 25, 50, 100, 200):
    row = []
    for name, poker, slots in SCENARIOS:
        ggy = poker * POKER_HOURS * POKER_GGY_PER_HOUR + slots * SLOT_SESSIONS * SLOT_GGY_PER_SESSION
        new = (poker + slots) * NEW_SHARE
        lic = next((fee for cap, fee in LICENCE_YEAR if ggy * 12 < cap), 12_375)
        host = hosting(poker * POKER_HOURS, slots * SLOT_SESSIONS * SLOT_SESSION_HOURS)[0] * USD_TO_GBP
        row.append(ggy * (1 - DUTY - PAYMENTS) - new * (cpa + KYC) - lic / 12 - STAFF_COMPLIANCE - host)
    print(f"   CPA £{cpa:<4}" + "".join(f"{n}: {gbp(v):>9}   " for (n, _, _), v in zip(SCENARIOS, row)))

print("\n   One-off before launch (rough): UKGC application £8,185 [R]; RNG and game certification per game, legal,")
print("   policies and responsible-gambling tooling, roughly £20k-£40k all in.")

# ================================================================ 3. the demo as it is now
print("\n3) THE FREE-PLAY DEMO AS IT IS (no gambling income; cosmetics are the only possible revenue)")
for online in (10, 50, 200):
    usd = hosting(online * 360, online * 360)[0]
    monthly = online * 720 / 4   # rough monthly unique players at ~4 h each
    cos = monthly * 0.05 * 5 / 1.2
    print(f"   {online:>4} online: hosting ~{gbp(usd * USD_TO_GBP)}/month; cosmetics if 5% of ~{monthly:,.0f} players spend £5: ~{gbp(cos)}/month after VAT")
