import type { Lobby } from "./lobby.ts";
import type { Table } from "./table.ts";

export interface Env {
  DB: D1Database;
  HANDS: R2Bucket;
  TABLE: DurableObjectNamespace<Table>;
  LOBBY: DurableObjectNamespace<Lobby>;
  LOGIN_LIMIT?: RateLimit; // sign-ups per IP per minute
  TURN_SECONDS?: string; // time a human has to act (default 20)
  BOT_DELAY_MS?: string; // how long bots "think" (default 1100)
  NEXT_HAND_MS?: string; // pause between hands, long enough for the win animations (default 5500)
  RAKE_PERCENT?: string; // house cut on tables; "0" for free play
  STARTING_CHIPS?: string; // play chips for a new account (default 1000)
  AUDIT?: string; // "1" enables GET /api/audit (dev/test only)
  PAYMENTS_MODE?: string; // "test" = shop purchases are simulated, no money taken
  UNLIMITED?: string; // "1" = demo: play chips never run out (auto top-up and re-buy) and every shop item unlocks free
}
