import type { Lobby } from "./lobby.ts";
import type { Table } from "./table.ts";

export interface Env {
  DB: D1Database;
  HANDS: R2Bucket;
  TABLE: DurableObjectNamespace<Table>;
  LOBBY: DurableObjectNamespace<Lobby>;
  ASSETS: Fetcher;
  TURN_SECONDS?: string; // time a human has to act (default 20)
  BOT_DELAY_MS?: string; // how long bots "think" (default 1000)
  NEXT_HAND_MS?: string; // pause between hands (default 4000)
  AUDIT?: string; // "1" enables GET /api/audit (dev/test only)
}
