# Card Table

Multiplayer Texas Hold'em and two slot machines, running entirely on Cloudflare. Free-play (play chips) launch build.

**Live:** https://cfgt-poker.daniel-golding96.workers.dev · Showroom of every cosmetic: `/?demo=showroom`

## How it fits together

| Piece | Cloudflare product | What it does |
|---|---|---|
| `src/index.ts` | Worker | Website, JSON API (`/api/login`, `/api/me`, `/api/play`, `/api/daily`, `/api/hands/...`), WebSocket door |
| `src/lobby.ts` | Durable Object (1) | Quick seat (fills tables first), private tables, remembers each player's table, pushes the live table list to lobby viewers over one hibernating WebSocket each |
| `src/table.ts` | Durable Object (1 per table) | The authority: shuffles, deals, turns, timers, bots, chip movements |
| `src/ledger.ts` + `migrations/` | D1 | Double-entry play-chip ledger; every transfer idempotent, balances can't go negative |
| hand histories | R2 | Every finished hand, with the deck and salts, for audits and disputes |
| `audio/` + `public/sound.js` | R2 | 19 sound effects and 3 music loops, served by the Worker at `/audio/v1/...` (cached for good, byte ranges supported) |
| `src/holdem.ts`, `src/cards.ts` | — | Rules engine, CSPRNG shuffle, hand evaluator, per-card deck commitments |
| `src/slots.ts` + `migrations/0003_slots.sql` | Durable Object (1 per player) + D1 | Slot machines: the player's seeds, nonce and spins; stake and payout through the ledger; spin and seed audit trail |
| `public/machines.js`, `public/fair.js` | — | Published reel strips and paytables, exact RTP, and the provably-fair spin derivation, shared by server, browser and tests |
| `src/stakes.ts` | — | Stake tiers and disclosed house fees (for a future licensed real-money mode) |
| `src/shop.ts`, `src/catalog.ts` + `migrations/0002_shop.sql` | D1 | Cosmetics shop: catalogue, ownership, equipped items, purchases. `PAYMENTS_MODE=test` simulates checkout; a payment provider's confirmed-payment webhook would call `grantPurchase()` |
| `public/` | (bundled into the Worker) | Client: table UI, animations, decks, rooms, chips, celebrations |

Rooms: "Take a seat" puts you at the busiest table with a free seat; the lobby also lists every public table live
(people, bots, watchers, stakes, the pot in play) with Join and Watch. Watchers get exactly what an unseated person
sees (no hidden cards), up to 20 per table. Private tables have long unguessable ids, never appear in the list, are
never used by quick seat, and are joined by an invite link (`/?table=p-...`).

Disconnection recovery: a dropped player keeps their seat and chips for `AWAY_SECONDS` (default 180). They finish the
current hand on the normal turn timer, then sit out (no blinds, no auto-folds) until they're back; after the hold
their stack goes back to their balance. The client reconnects by itself (with a heartbeat the server answers without
waking up), and a reload or another device rejoins via `/api/me`. Every chip movement (buy-in, top-up, re-buy,
cash-out) is saved with the table before its ledger transfer and applied after, so a server restart in between is
finished on the next event by retrying the same idempotent transfer: nothing is stranded.

Cosmetics: decks, rooms, chip sets and win celebrations. Other players see your card backs and your win
celebration; rooms and chip sets are how *you* see the table. Sign-ups are rate-limited to 5 per minute per IP.

Sound: effects play through Web Audio, in time with the animations; music streams and crossfades at its loop point,
one track per room style. Nothing plays before the player interacts, music is off until they turn it on, and both have
their own switch and volume in the header's speaker menu. The audio was generated with ElevenLabs (sound effects and
Eleven Music, paid plan with commercial use) and approved sound by sound.

Fairness: before each deal the house shuffles and publishes the deck's fingerprint (per-card SHA-256 with secret
salts). Each player's browser then adds a random seed, and the dealt deck is the committed deck reordered by all the
seeds (`public/fair.js`, shared by server and browser). So the house can't choose the deck (it committed first) and no
player can steer it (only the dealer knows the committed deck). After the hand each player gets a proof for the cards
they saw, checks every card came from its dealt position, and sees whether their own seed was mixed in; folded hands
stay private. Bots decide from a view of their own seat only (`botView`), never the table state.

## Slot machines

Two machines sit beside poker in the lobby. Both are the player against a published paytable (no bots), in play money
only: stakes are 10p, 20p, 50p, £1, £2 or £5 a spin (100 play chips = £1; capped at £5 as UK online slots are), and a
win is always the paytable multiple of the stake.

| Machine | What it is | Exact RTP | Combinations | Top win |
|---|---|---|---|---|
| Lucky Sevens | Classic 3 reels of 24 stops, one win line: fruit, bars, bells, sevens | 95.21% (13,162 / 13,824) | 13,824 | 200× |
| Royal Reels | One 52-card deck dealt across 5 reels (each card on exactly one reel); the middle row pays as a poker hand. Drawn with the player's equipped deck, room and celebration | 94.98% (114,923 / 121,000) | 121,000 | 2,500× |

Fairness: the server commits to a secret seed (its SHA-256 is shown) before any spin; the player's browser supplies a
client seed (they can type their own); a nonce counts spins. Reel stops are HMAC-SHA256(server seed, "client seed:nonce:machine:round")
read as 32-bit numbers with rejection sampling, so every stop is exactly equally likely: no weighting, no virtual
reels, and the strips drawn on screen are the strips that are spun. The next server seed is committed in advance too.
Changing seeds reveals the old server seed, and the browser re-plays and checks every spin made with it
(`verifySpin` in `public/fair.js`). Each player has one Durable Object, so seeds and nonces stay consistent across tabs
and devices; a spin is saved before its ledger transfers (refs `slot:<user>:<seed>:<nonce>:stake|payout`) and finished
after a restart, never twice.

Responsible design follows the UK Gambling Commission's remote technical standards even though this is play money:
no autoplay (RTS 8A), at least 2.5 s per spin enforced by the server and one game at a time per player (14C, 14D), no
turbo, quick-spin or slam-stop (14E), no win sound or celebration for a return of the stake or less (14F), and time
played plus the session's net result always on screen next to Stop (13C).

## Develop

```bash
npm install
npx wrangler d1 migrations apply DB --local
node tools/upload-audio.mjs --local
npx wrangler dev --var BOT_DELAY_MS:150 --var NEXT_HAND_MS:1200 --var TURN_SECONDS:6 --var AUDIT:1
```

## Test

```bash
node tests/slots.test.ts           # slots: exact RTP by enumeration, 10,000,000 simulated spins per machine, fairness and tamper checks (about 2 minutes)
node tests/slots-api.mjs           # slots server: ledger, 2.5 s pacing, idempotent presses, two tabs, crash recovery, seed reveal (needs the dev server with AUDIT:1)
node tests/slots.cjs               # slots in a browser: lobby picker, both machines, responsible-design rules, in-page verification (needs the dev server)
node tests/engine.test.ts          # rules engine: 12 tests incl. 3,000 random hands, replay and the fairness check
node tests/four-players.cjs        # 4 real browsers at one table (needs the dev server)
node tests/abuse.mjs               # cheating/abuse attempts (needs the dev server)
node tests/shop.cjs                # shop rules + another player sees your equipped deck (needs the dev server)
node tests/unlimited.mjs           # demo mode: unlimited chips, auto re-buy on bust, everything unlocks free
node tests/leave-midhand.mjs       # leaving mid-hand: folded and released at once, pot chips kept, ledger at 0
node tests/hand-pace.mjs           # next hand deals after the normal pause, not a leftover turn timer (TURN_SECONDS:20)
node tests/between-hands.mjs       # countdown between hands, Top up, Continue (all ready = deal now)
node tests/sound.cjs               # effects fire with the game, music follows the room, settings switch and persist
node tests/seeds.mjs               # player seeds are mixed into the shuffle, can't be swapped, and the deal verifies
node tests/reconnect.mjs           # seat held while away, sat out, released after the hold, crash recovery (AWAY_SECONDS:12, AUDIT:1)
node tests/reconnect-full.mjs      # a full table whose players drop doesn't freeze the last player (AWAY_SECONDS:12)
node tests/reconnect.cjs           # browser: reconnect banner, back in the same seat, reload rejoins, leaving really leaves
node tests/lobby.cjs               # live table list, watching (no hidden cards), take a seat, private tables and invite links
npm run test:cards                 # no part of any card touches another (needs the dev server)
node tests/chip-layout.cjs         # chips never cover cards, labels or nameplates (needs the dev server)
```

## Deploy

```bash
npx wrangler d1 migrations apply DB --remote
node tools/upload-audio.mjs --remote   # only when the audio changes; bump the version in it and in public/sound.js
npx wrangler deploy
```

Settings live in `wrangler.jsonc` `vars`: `TURN_SECONDS`, `BOT_DELAY_MS`, `NEXT_HAND_MS`, `RAKE_PERCENT` (0 for free play),
`STARTING_CHIPS`, `AWAY_SECONDS` (how long a dropped player's seat is held), `AUDIT` (keep "0" in production), `UNLIMITED` ("1" for the demo: balances are topped up from the mint
account, busted players re-buy instead of leaving, and every shop item unlocks free; set "0" to restore normal chips and
`PAYMENTS_MODE`). Set Workers and Durable Objects spending limits in the dashboard.

## Business models

`tools/earnings_model.py` and `tools/growth_model.py` (UK real-money economics, light-advertising growth).
