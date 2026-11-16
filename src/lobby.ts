import { DurableObject } from "cloudflare:workers";
import { SEAT_COUNT } from "./holdem.ts";
import type { Env } from "./env.ts";

/** Single-instance Durable Object that sends players to a table with a free seat (filling tables first). */
export class Lobby extends DurableObject<Env> {
  async assign(): Promise<string> {
    const tables = (await this.ctx.storage.get<Record<string, number>>("tables")) ?? {};
    const open = Object.entries(tables)
      .filter(([, humans]) => humans < SEAT_COUNT)
      .sort((a, b) => b[1] - a[1]);
    const id = open[0]?.[0] ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    tables[id] = (tables[id] ?? 0) + 1; // reserve a seat until the table reports its real count
    await this.ctx.storage.put("tables", tables);
    return id;
  }

  async report(tableId: string, humans: number): Promise<void> {
    const tables = (await this.ctx.storage.get<Record<string, number>>("tables")) ?? {};
    if (humans <= 0) delete tables[tableId];
    else tables[tableId] = humans;
    await this.ctx.storage.put("tables", tables);
  }

  async list(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>("tables")) ?? {};
  }
}
