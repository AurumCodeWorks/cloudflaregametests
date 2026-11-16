#!/usr/bin/env python3
"""
Earnings model for a UK real-money poker product where the house earns from entry fees
(Sit & Go style: "£5 + £0.45" means £5 goes to the prize pool and £0.45 to the house).
This is how legitimate poker operators make money: the house never plays a hand.

Run:  python3 tools/earnings_model.py
Every input below is an assumption you can change. Researched figures are marked [R].
"""

# ---------------------------------------------------------------- stake tiers
# Fee % is within the 7-10% range typical for Sit & Go fees [R], falling as stakes rise.
TIERS = [  # name, buy-in £, fee %, share of all entries
    ("Micro",  1,   0.100, 0.45),
    ("Low",    5,   0.090, 0.30),
    ("Mid",    10,  0.080, 0.15),
    ("High",   25,  0.075, 0.07),
    ("VIP",    100, 0.060, 0.03),
]
SEATS = 4                 # 4-handed Sit & Go (matches the table we built)
ENTRIES_PER_HOUR = 2.5    # a 4-max turbo lasts ~15-25 min; players bust and re-enter

# ---------------------------------------------------------------- costs
REMOTE_GAMING_DUTY = 0.40      # [R] UK RGD 21% -> 40% from 1 April 2026, on gross gambling profit
PAYMENTS_PCT_OF_GGY = 0.10     # deposits/withdrawals via a gambling-approved processor (assumption)
KYC_PER_NEW_PLAYER = 1.50      # identity + age checks per new account (assumption)
CPA_PER_NEW_DEPOSITOR = 100.0  # [R] UK sources range £25-£600; poker sits at the low end
NEW_PLAYER_SHARE = 0.30        # share of monthly players who are new that month (assumption)
CLOUDFLARE_MONTHLY = 50.0      # from our earlier model: ~£15-£90/month
UKGC_ANNUAL = {250_000: 7_000, 875_000: 12_375}   # [R] remote casino licence, from 1 Oct 2026
UKGC_APPLICATION = 8_185                           # [R] one-off (band F1)

SCENARIOS = [  # name, monthly real-money players, hours each per month
    ("Launch", 300, 6),
    ("Target (~100 peak)", 1_500, 8),
    ("Growth", 5_000, 10),
]

fee_per_entry = sum(b * f * share for _, b, f, share in TIERS)
avg_buyin = sum(b * share for _, b, _, share in TIERS)

def gbp(x): return f"£{x:,.0f}"

print("Stake tiers (what the player pays, what the house keeps)")
print(f"{'tier':<7}{'entry':>12}{'house fee':>11}{'house per 4-player game':>26}{'prize pool':>12}")
for name, b, f, share in TIERS:
    fee = b * f
    print(f"{name:<7}{f'£{b} + £{fee:.2f}':>12}{f'{f*100:.1f}%':>11}{f'£{fee*SEATS:.2f}':>26}{f'£{b*SEATS}':>12}")
print(f"\nBlended: average buy-in £{avg_buyin:.2f}, average house fee per entry £{fee_per_entry:.3f}\n")

print(f"{'scenario':<20}{'players':>8}{'avg online':>11}{'entries/mo':>12}{'turnover':>11}{'GGY':>10}"
      f"{'duty 40%':>10}{'payments':>10}{'marketing':>11}{'KYC':>7}{'licence':>9}{'infra':>7}{'= monthly':>11}")
for name, players, hours in SCENARIOS:
    player_hours = players * hours
    concurrent = player_hours / (30 * 24)
    entries = player_hours * ENTRIES_PER_HOUR
    ggy = entries * fee_per_entry
    turnover = entries * avg_buyin
    duty = ggy * REMOTE_GAMING_DUTY
    payments = ggy * PAYMENTS_PCT_OF_GGY
    new_players = players * NEW_PLAYER_SHARE
    marketing = new_players * CPA_PER_NEW_DEPOSITOR
    kyc = new_players * KYC_PER_NEW_PLAYER
    annual_ggy = ggy * 12
    licence = next((fee for cap, fee in UKGC_ANNUAL.items() if annual_ggy < cap), None)
    licence_m = (licence / 12) if licence else float("nan")
    net = ggy - duty - payments - marketing - kyc - (licence_m if licence else 0) - CLOUDFLARE_MONTHLY
    lic_txt = gbp(licence_m) if licence else "higher band"
    print(f"{name:<20}{players:>8,}{concurrent:>11.1f}{entries:>12,.0f}{gbp(turnover):>11}{gbp(ggy):>10}"
          f"{gbp(duty):>10}{gbp(payments):>10}{gbp(marketing):>11}{gbp(kyc):>7}{lic_txt:>9}{gbp(CLOUDFLARE_MONTHLY):>7}{gbp(net):>11}")

print("\nNot included above (real, and usually larger than they look): staff and compliance officers,")
print(f"one-off UKGC application ({gbp(UKGC_APPLICATION)}), independent RNG/game testing, legal, support, fraud and")
print("chargebacks, and responsible-gambling tooling. Marketing is shown at a single CPA; it is the biggest swing factor.")

print("\nSensitivity: Target scenario monthly result at different acquisition costs (CPA)")
name, players, hours = SCENARIOS[1]
entries = players * hours * ENTRIES_PER_HOUR
ggy = entries * fee_per_entry
for cpa in (25, 50, 100, 200, 400):
    net = ggy * (1 - REMOTE_GAMING_DUTY - PAYMENTS_PCT_OF_GGY) - players * NEW_PLAYER_SHARE * (cpa + KYC_PER_NEW_PLAYER) - UKGC_ANNUAL[250_000] / 12 - CLOUDFLARE_MONTHLY
    print(f"  CPA £{cpa:<4} -> {gbp(net)} / month")

# ---------------------------------------------------------------- unit economics
print("\nPer-player economics (what decides whether this business works)")
for hours in (4, 8, 15, 30):
    ggy_pm = hours * ENTRIES_PER_HOUR * fee_per_entry
    net_pm = ggy_pm * (1 - REMOTE_GAMING_DUTY - PAYMENTS_PCT_OF_GGY)
    row = f"  {hours:>2} h/month: house fee £{ggy_pm:6.2f}, after duty+payments £{net_pm:5.2f}/month  | lifetime value at "
    row += ", ".join(f"{int(c*100)}% monthly churn £{net_pm / c:,.0f}" for c in (0.30, 0.15, 0.08))
    print(row)
print("  A player is worth acquiring only if lifetime value > CPA + KYC. Poker CPA research: ~£30-£100 at the low end.")

# Cosmetics (decks, rooms, chips, celebrations) are ordinary digital goods: VAT 20%, no gambling duty
COSMETIC_BUYER_SHARE, COSMETIC_SPEND = 0.08, 6.0
name, players, hours = SCENARIOS[1]
cos = players * COSMETIC_BUYER_SHARE * COSMETIC_SPEND / 1.2
print(f"\nCosmetics side-income, Target scenario ({int(COSMETIC_BUYER_SHARE*100)}% of players spend £{COSMETIC_SPEND:.0f}/month): ~{gbp(cos)}/month after VAT")

# Break-even players at a sustainable acquisition cost
print("\nBreak-even: monthly players needed to cover fixed costs, assuming 8 h/month, 10% churn, CPA £40")
ggy_pm = 8 * ENTRIES_PER_HOUR * fee_per_entry
margin_pm = ggy_pm * (1 - REMOTE_GAMING_DUTY - PAYMENTS_PCT_OF_GGY) - 0.10 * (40 + KYC_PER_NEW_PLAYER)
for fixed in (2_000, 10_000, 25_000):
    print(f"  fixed costs {gbp(fixed)}/month (licence, infra{', staff' if fixed > 2_000 else ''}) -> {fixed / margin_pm:,.0f} monthly players")
