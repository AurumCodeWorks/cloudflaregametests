import { DurableObject } from "cloudflare:workers";
import { SEAT_COUNT as SEATS } from "./holdem.ts";
import type { Env } from "./env.ts";

/** What the lobby list shows for a table (reported by the table itself). */
export interface TableSummary {
  id: string;
  people: number; // seated people, including seats held for someone who dropped
  away: number;
  bots: number;
  waiting: number;
  watchers: number;
  seats: number;
  blinds: [number, number];
  buyIn: number;
  pot: number; // the pot of the hand in play (0 between hands)
  street: string | null; // "preflop", "flop", ... or null between hands
  handNo: number;
  lastPot: number; // the last finished hand's pot
  updatedAt: number;
}
/** Private tables have long unguessable ids, never appear in the list, and quick seat never uses them. */
export const isPrivateTable = (id: string) => id.startsWith("p-");
export const TABLE_ID = /^(t-[0-9a-f]{8}|p-[0-9a-f]{16})$/;
const RESERVE_MS = 10000;

/**
 * Single-instance Durable Object. It sends players to a table with a free seat (filling tables first),
 * remembers which table each player belongs to (so a dropped connection, a reload or another device can
 * take them back to their seat), and serves the live table list to anyone looking at the lobby: list
 * viewers hold one hibernating WebSocket and get pushed updates (outgoing messages aren't billed).
 */
export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * Quick seat: the public table with the most people actually playing that still has a free seat. Seats held
   * for players who dropped count as taken but not as "playing", so a table where everyone is away never
   * swallows newcomers; with no suitable table, a new one opens (bots fill it until people join).
   */
  async assign(): Promise<string> {
    const st = this.ctx.storage;
    const now = Date.now();
    const reserved = (await st.get<Record<string, { n: number; at: number }>>("reserved")) ?? {};
    for (const k of Object.keys(reserved)) if (reserved[k].at < now - RESERVE_MS) delete reserved[k];
    const listed = await this.list();
    // People present: seated and not away, or waiting to be dealt in; plus anyone just sent there
    const open = listed.map((t) => ({ id: t.id, playing: t.people - t.away + t.waiting + (reserved[t.id]?.n ?? 0), taken: t.people + t.waiting + (reserved[t.id]?.n ?? 0), seats: t.seats }));
    // A table opened moments ago hasn't reported yet: the people sent to it still count, so arrivals group up
    for (const [id, r] of Object.entries(reserved)) if (!isPrivateTable(id) && !listed.some((t) => t.id === id)) open.push({ id, playing: r.n, taken: r.n, seats: SEATS });
    open.sort((a, b) => b.playing - a.playing);
    const best = open.find((t) => t.playing > 0 && t.taken < t.seats);
    const id = best?.id ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    // Hold the seat for a few seconds, until the table reports the newcomer itself
    reserved[id] = { n: (reserved[id]?.n ?? 0) + 1, at: now };
    await st.put("reserved", reserved);
    return id;
  }

  /** A new private table: share its link to play with friends. */
  async createPrivate(): Promise<string> {
    return `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  /** A table reports how many people it holds, who they are (seated, held while away, or waiting) and its summary. */
  async report(tableId: string, humans: number, members: string[] = [], summary?: TableSummary): Promise<void> {
    const st = this.ctx.storage;
    const reserved = (await st.get<Record<string, { n: number; at: number }>>("reserved")) ?? {};
    if (reserved[tableId]) { delete reserved[tableId]; await st.put("reserved", reserved); } // the table has counted its newcomers itself
    const before = (await st.get<string[]>(`members:${tableId}`)) ?? [];
    const gone = before.filter((u) => !members.includes(u));
    if (gone.length) {
      const where = await st.get<string>(gone.map((u) => `where:${u}`));
      const stale = gone.filter((u) => where.get(`where:${u}`) === tableId);
      if (stale.length) await st.delete(stale.map((u) => `where:${u}`));
    }
    const writes: Record<string, unknown> = {};
    for (const u of members) writes[`where:${u}`] = tableId;
    if (members.length) writes[`members:${tableId}`] = members;
    else await st.delete(`members:${tableId}`);
    if (summary && humans > 0) writes[`info:${tableId}`] = summary;
    else await st.delete(`info:${tableId}`);
    await st.put(writes);
    if (!isPrivateTable(tableId)) await this.push();
  }

  /** The table a player belongs to right now, if any. */
  async whereIs(userId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`where:${userId}`)) ?? null;
  }

  /** Public tables with people at them, busiest first. */
  async list(): Promise<TableSummary[]> {
    const infos = await this.ctx.storage.list<TableSummary>({ prefix: "info:" });
    return [...infos.values()].filter((t) => !isPrivateTable(t.id) && t.people + t.waiting > 0).sort((a, b) => b.people - a.people || b.updatedAt - a.updatedAt);
  }

  // ---------------------------------------------------------------- live list for lobby viewers
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    if (this.ctx.getWebSockets().length >= 2000) return new Response("Lobby busy", { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "tables", tables: await this.list() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage() { /* viewers only listen */ }
  async webSocketClose(ws: WebSocket) { try { ws.close(1000, "closed"); } catch { /* gone */ } }
  private async push() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const msg = JSON.stringify({ type: "tables", tables: await this.list() });
    for (const ws of sockets) try { ws.send(msg); } catch { /* closing */ }
  }
}
