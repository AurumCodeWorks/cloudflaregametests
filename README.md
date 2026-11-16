# Card Table

Multiplayer Texas Hold'em that runs entirely on Cloudflare. Free-play (play chips) launch build.

**Live:** https://cfgt-poker.daniel-golding96.workers.dev · Showroom of every cosmetic: `/?demo=showroom`

## How it fits together

| Piece | Cloudflare product | What it does |
|---|---|---|
| `src/index.ts` | Worker | Website, JSON API (`/api/login`, `/api/me`, `/api/play`, `/api/daily`, `/api/hands/...`), WebSocket door |
| `src/lobby.ts` | Durable Object (1) | Sends players to a table with a free seat, filling tables first |
| `src/table.ts` | Durable Object (1 per table) | The authority: shuffles, deals, turns, timers, bots, chip movements |
| `src/ledger.ts` + `migrations/` | D1 | Double-entry play-chip ledger; every transfer idempotent, balances can't go negative |
| hand histories | R2 | Every finished hand, with the deck and salts, for audits and disputes |
| `src/holdem.ts`, `src/cards.ts` | — | Rules engine, CSPRNG shuffle, hand evaluator, per-card deck commitments |
| `src/stakes.ts` | — | Stake tiers and disclosed house fees (for a future licensed real-money mode) |
| `public/` | (bundled into the Worker) | Client: table UI, animations, decks, rooms, chips, celebrations |

Fairness: the deck is committed (per-card SHA-256) before dealing and each player gets a proof for the cards
they saw after the hand; folded hands stay private. The house never plays and never touches the cards.

## Develop

```bash
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev --var BOT_DELAY_MS:150 --var NEXT_HAND_MS:1200 --var TURN_SECONDS:6 --var AUDIT:1
```

## Test

```bash
node tests/engine.test.ts          # rules engine: 9 tests incl. 3,000 random hands + replay
node tests/four-players.cjs        # 4 real browsers at one table (needs the dev server)
node tests/abuse.mjs               # cheating/abuse attempts (needs the dev server)
npm run test:cards                 # no part of any card touches another (serve /public on :8790)
node tests/chip-layout.cjs         # chips never cover cards, labels or nameplates (serve /public on :8790)
```

## Deploy

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Settings live in `wrangler.jsonc` `vars`: `TURN_SECONDS`, `BOT_DELAY_MS`, `NEXT_HAND_MS`, `RAKE_PERCENT` (0 for free play),
`STARTING_CHIPS`, `AUDIT` (keep "0" in production). Set Workers and Durable Objects spending limits in the dashboard.

## Business models

`tools/earnings_model.py` and `tools/growth_model.py` (UK real-money economics, light-advertising growth).
