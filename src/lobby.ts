import { DurableObject } from "cloudflare:workers";
import { SEAT_COUNT } from "./holdem.ts";
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

  async assign(): Promise<string> {
    const tables = (await this.ctx.storage.get<Record<string, number>>("tables")) ?? {};
    const open = Object.entries(tables)
      .filter(([id, humans]) => humans < SEAT_COUNT && !isPrivateTable(id))
      .sort((a, b) => b[1] - a[1]);
    const id = open[0]?.[0] ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    tables[id] = (tables[id] ?? 0) + 1; // reserve a seat until the table reports its real count
    await this.ctx.storage.put("tables", tables);
    return id;
  }

  /** A new private table: share its link to play with friends. */
  async createPrivate(): Promise<string> {
    const id = `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const tables = (await this.ctx.storage.get<Record<string, number>>("tables")) ?? {};
    tables[id] = 1;
    await this.ctx.storage.put("tables", tables);
    return id;
  }

  /** A table reports how many people it holds, who they are (seated, held while away, or waiting) and its summary. */
  async report(tableId: string, humans: number, members: string[] = [], summary?: TableSummary): Promise<void> {
    const st = this.ctx.storage;
    const tables = (await st.get<Record<string, number>>("tables")) ?? {};
    if (humans <= 0) delete tables[tableId];
    else tables[tableId] = humans;
    const before = (await st.get<string[]>(`members:${tableId}`)) ?? [];
    const gone = before.filter((u) => !members.includes(u));
    if (gone.length) {
      const where = await st.get<string>(gone.map((u) => `where:${u}`));
      const stale = gone.filter((u) => where.get(`where:${u}`) === tableId);
      if (stale.length) await st.delete(stale.map((u) => `where:${u}`));
    }
    const writes: Record<string, unknown> = { tables };
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
