// One Durable Object per poker table. It is the only authority for the game: it shuffles, deals,
// enforces turns and timers, runs the bots, moves play chips through the D1 ledger, and stores
// every finished hand in R2. Clients only ever send intentions ("call", "raise to 120").
//
// Cost notes: WebSockets use the Hibernation API, so an idle table costs nothing; a table with
// players is woken only by player messages and its single alarm (turn timer / next hand).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { commitDeck, freshDeck, randomHex, secureShuffle } from "./cards.ts";
import type { RevealItem } from "./cards.ts";
import {
  act, BIG_BLIND, BUY_IN, DEFAULT_RAKE, historyOf, legalActions, newSeat, newTable, potTotal, revealFor, SEAT_COUNT, startHand, timeoutAction,
} from "./holdem.ts";
import type { Action, ActionRecord, RakeRule, TableState } from "./holdem.ts";
import { BOT_NAMES, decide } from "./bot.ts";
import { transfer } from "./ledger.ts";
import { tableCosmetics } from "./shop.ts";

interface Waiting { userId: string; name: string }
interface Persisted {
  tableId: string;
  t: TableState;
  waiting: Waiting[];
  log: string[];
  botSeq: number;
  next: { at: number; kind: "hand" | "act" } | null;
  turnDeadline: number | null;
  leaves: string[] | null; // per-card commitment leaves for the current hand (server-side only)
  cosmetics?: Record<string, { deck: string; celebration: string }>; // what others see of each player
  ready?: string[]; // between hands: people who pressed Continue (all ready = deal now)
}
const BOT_COSMETICS = { deck: "modern", celebration: "glow" };
interface Attachment { userId: string; name: string; windowStart: number; count: number }

const ACTIONS = new Set(["fold", "check", "call", "raise", "allin"]);
const MAX_MSGS_PER_SECOND = 20;
const DISCONNECTED_TURN_MS = 5000;
const READY_DEAL_MS = 700; // when everyone presses Continue, deal after this short beat // a player whose connection dropped gets a short grace period, not the full timer
const SUIT: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const cardText = (c: string) => (c[0] === "T" ? "10" : c[0]) + SUIT[c[1]];
const withArticle = (hand: string) => (/^[AEIOU]/i.test(hand) ? `an ${hand.toLowerCase()}` : `a ${hand.toLowerCase()}`);

export class Table extends DurableObject<Env> {
  private p: Persisted | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.p = (await ctx.storage.get<Persisted>("p")) ?? null;
    });
  }

  // ------------------------------------------------------------------ config
  private get turnMs() { return Number(this.env.TURN_SECONDS ?? 20) * 1000; }
  private get nextHandMs() { return Number(this.env.NEXT_HAND_MS ?? 5500); }
  private get unlimited() { return this.env.UNLIMITED === "1"; }
  private botDelay() { return Number(this.env.BOT_DELAY_MS ?? 1100) * (0.7 + Math.random() * 0.8); }
  private rakeRule(): RakeRule {
    const percent = Number(this.env.RAKE_PERCENT ?? 0);
    return percent > 0 ? { ...DEFAULT_RAKE, percent } : { percent: 0, cap: 0, noFlopNoDrop: true };
  }

  /** Run state-changing work one at a time, even across awaits on D1/R2 (which open the input gate). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------------------ connections
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const userId = req.headers.get("X-User-Id");
    const name = req.headers.get("X-User-Name");
    const tableId = req.headers.get("X-Table-Id");
    if (!userId || !name || !tableId) return new Response("Missing identity", { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [userId]);
    server.serializeAttachment({ userId, name, windowStart: Date.now(), count: 0 } satisfies Attachment);
    await this.run(() => this.onJoin(server, userId, name, tableId));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async onJoin(ws: WebSocket, userId: string, name: string, tableId: string) {
    if (!this.p) this.p = { tableId, t: newTable(), waiting: [], log: [], botSeq: 0, next: null, turnDeadline: null, leaves: null };
    const p = this.p;
    p.t.rake ??= this.rakeRule();
    await this.loadCosmetics(userId);
    const seat = this.seatOf(userId);
    const waiting = p.waiting.some((w) => w.userId === userId);
    if (seat < 0 && !waiting) {
      if (this.humans() >= SEAT_COUNT) {
        this.send(ws, { type: "error", message: "That table just filled up. Take a seat again for another table." });
        ws.close(4001, "full");
        return;
      }
      p.waiting.push({ userId, name });
      this.log(`${name} joined the table`);
    } else if (seat >= 0) {
      const s = p.t.seats[seat]!;
      s.leaving = false;
      s.timeouts = 0;
      const h = p.t.hand;
      if (h && !h.result && h.toAct === seat) { // reconnected on your turn: the full timer again
        p.turnDeadline = Date.now() + this.turnMs;
        await this.schedule("act", p.turnDeadline);
      }
    }
    if ((!p.t.hand || p.t.hand.result) && p.next?.kind !== "hand") await this.schedule("hand", Date.now() + 600);
    await this.persist();
    this.broadcast();
    await this.reportLobby();
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    if (now - att.windowStart > 1000) { att.windowStart = now; att.count = 0; }
    att.count++;
    ws.serializeAttachment(att);
    if (att.count > MAX_MSGS_PER_SECOND) { ws.close(1008, "Too many messages"); return; }
    if (typeof msg !== "string" || msg.length > 300) { ws.close(1009, "Message too large"); return; }
    let m: { type?: string; action?: string; to?: unknown };
    try { m = JSON.parse(msg); } catch { this.send(ws, { type: "error", message: "Bad message" }); return; }
    await this.run(async () => {
      if (!this.p) return;
      if (m.type === "action") await this.onAction(ws, att.userId, m);
      else if (m.type === "leave") await this.onLeave(att.userId);
      else if (m.type === "cosmetics") { await this.loadCosmetics(att.userId); await this.persist(); this.broadcast(); }
      else if (m.type === "ready") await this.onReady(ws, att.userId);
      else if (m.type === "topup") await this.onTopUp(ws, att.userId);
    });
  }

  async webSocketClose(ws: WebSocket) { await this.onDisconnect(ws); }
  async webSocketError(ws: WebSocket) { await this.onDisconnect(ws); }

  private async onDisconnect(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    await this.run(async () => {
      const p = this.p;
      if (!p || this.connected(att.userId, ws)) return;
      p.waiting = p.waiting.filter((w) => w.userId !== att.userId);
      // A seated player who disconnects keeps their seat until the hand ends; their turn timer handles it.
      if ((!p.t.hand || p.t.hand.result) && p.next?.kind !== "hand") await this.schedule("hand", Date.now() + 500);
      await this.persist();
      this.broadcast();
      await this.reportLobby();
    });
  }

  // ------------------------------------------------------------------ player actions
  private async onAction(ws: WebSocket, userId: string, m: { action?: string; to?: unknown }) {
    const t = this.p!.t;
    const h = t.hand;
    const seat = this.seatOf(userId);
    if (seat < 0 || !h || h.result) return this.send(ws, { type: "error", message: "You're not in this hand" });
    if (!m.action || !ACTIONS.has(m.action)) return this.send(ws, { type: "error", message: "Unknown action" });
    const a: Action = { type: m.action as Action["type"] };
    if (m.action === "raise") {
      if (typeof m.to !== "number" || !Number.isInteger(m.to)) return this.send(ws, { type: "error", message: "Raise amount must be a whole number" });
      a.to = m.to;
    }
    const err = this.apply(() => act(t, seat, a));
    if (err) return this.send(ws, { type: "error", message: err });
    await this.afterChange();
  }

  private async onLeave(userId: string) {
    const p = this.p!;
    p.waiting = p.waiting.filter((w) => w.userId !== userId);
    const seat = this.seatOf(userId);
    if (seat >= 0) {
      const s = p.t.seats[seat]!;
      const h = p.t.hand;
      if (h && !h.result && s.inHand && !s.folded) {
        // Still in the hand: folds on their turn (see afterChange), or, if all in, stays until it's decided
        s.leaving = true;
        if (!s.allIn) this.log(`${s.name} will fold and leave`);
      } else {
        await this.standUp(seat, "left");
      }
    } else {
      for (const ws of this.sockets(userId)) { this.send(ws, { type: "stood", amount: 0 }); ws.close(1000, "left"); }
    }
    await this.afterChange();
  }

  private betweenHands() { const h = this.p!.t.hand; return !h || !!h.result; }

  /** Continue: once everyone at the table is ready, deal now instead of waiting out the pause. */
  private async onReady(ws: WebSocket, userId: string) {
    const p = this.p!;
    if (this.seatOf(userId) < 0 || !this.betweenHands()) return this.send(ws, { type: "error", message: "You can continue once this hand is over" });
    p.ready = [...new Set([...(p.ready ?? []), userId])];
    const people = p.t.seats.filter((s) => s && !s.isBot && !s.cashedOut && !s.leaving && this.connected(s.userId));
    const soon = Date.now() + READY_DEAL_MS;
    if (people.every((s) => p.ready!.includes(s!.userId)) && p.next?.kind === "hand" && p.next.at > soon) await this.schedule("hand", soon);
    await this.persist();
    this.broadcast();
  }

  /** Top up your table stack to the maximum buy-in, between hands only. */
  private async onTopUp(ws: WebSocket, userId: string) {
    const p = this.p!;
    const seat = this.seatOf(userId);
    if (seat < 0 || !this.betweenHands()) return this.send(ws, { type: "error", message: "You can top up between hands" });
    const s = p.t.seats[seat]!;
    const amount = BUY_IN - s.stack;
    if (amount <= 0) return this.send(ws, { type: "error", message: `Your stack is already at the ${BUY_IN} maximum` });
    const ref = `topup:${p.tableId}:${userId}:${randomHex(6)}`;
    const r = this.unlimited
      ? await transfer(this.env.DB, "mint", `table:${p.tableId}`, amount, ref, "demo-topup")
      : await transfer(this.env.DB, `user:${userId}`, `table:${p.tableId}`, amount, ref, "topup");
    if (r === "insufficient") return this.send(ws, { type: "error", message: `You need ${amount} chips in your balance to top up` });
    s.stack += amount;
    this.log(`${s.name} tops up to ${BUY_IN}`);
    this.send(ws, { type: "toppedup", amount });
    await this.persist();
    this.broadcast();
  }

  /** Apply an engine change and narrate it in the table log. Returns an error message or null. */
  private apply(change: () => string | null | void): string | null {
    const t = this.p!.t;
    const h = t.hand!;
    const before = h.actions.length;
    const boardBefore = h.board.length;
    const err = change();
    if (err) return err;
    for (const r of h.actions.slice(before)) this.log(this.describe(r));
    const b = h.board;
    if (boardBefore < 3 && b.length >= 3) this.log(`Flop: ${b.slice(0, 3).map(cardText).join(" ")}`);
    if (boardBefore < 4 && b.length >= 4) this.log(`Turn: ${cardText(b[3])}`);
    if (boardBefore < 5 && b.length >= 5) this.log(`River: ${cardText(b[4])}`);
    return null;
  }

  private describe(r: ActionRecord): string {
    const name = this.p!.t.seats[r.seat]?.name ?? "Player";
    switch (r.type) {
      case "fold": return `${name} folds`;
      case "check": return `${name} checks`;
      case "call": return `${name} calls ${r.amount.toLocaleString("en-GB")}`;
      case "raise": return `${name} raises to ${r.to.toLocaleString("en-GB")}`;
      case "allin": return `${name} is all in (${r.to.toLocaleString("en-GB")})`;
    }
  }

  // ------------------------------------------------------------------ the game loop
  async alarm() {
    await this.run(async () => {
      const p = this.p;
      if (!p || !p.next) return;
      const { kind } = p.next;
      p.next = null;
      if (kind === "hand") return this.startNextHand();
      const h = p.t.hand;
      if (h && !h.result) {
        const seat = h.toAct;
        const s = p.t.seats[seat]!;
        if (s.isBot) {
          this.apply(() => act(p.t, seat, decide(p.t, seat)));
        } else if (Date.now() >= (p.turnDeadline ?? 0) - 50) {
          this.apply(() => { timeoutAction(p.t, seat); });
          this.log(`${s.name} ran out of time`);
          if (s.timeouts >= 2 || !this.connected(s.userId)) s.leaving = true;
        } else {
          await this.schedule("act", p.turnDeadline!);
          await this.persist();
          return;
        }
      }
      await this.afterChange();
    });
  }

  /** After any change: settle a finished hand, set the next timer, save, and tell everyone. */
  private async afterChange() {
    const p = this.p!;
    const h = p.t.hand;
    const now = Date.now();
    // Players who asked to leave fold the moment it's their turn and go, instead of running the clock down
    while (h && !h.result && p.t.seats[h.toAct]!.leaving && !p.t.seats[h.toAct]!.isBot) {
      const seat = h.toAct;
      this.apply(() => act(p.t, seat, { type: "fold" }));
      await this.standUp(seat, "left");
    }
    if (h?.result && !h.finalized) await this.finalizeHand();
    if (h && !h.result) {
      const s = p.t.seats[h.toAct]!;
      if (s.isBot) {
        p.turnDeadline = null;
        await this.schedule("act", now + this.botDelay());
      } else {
        p.turnDeadline = now + (this.connected(s.userId) ? this.turnMs : Math.min(this.turnMs, DISCONNECTED_TURN_MS));
        await this.schedule("act", p.turnDeadline);
      }
    } else if (p.next?.kind !== "hand") {
      // Hand over (or none yet): replace any leftover turn timer, which would otherwise hold up the next deal
      await this.schedule("hand", now + (h?.result ? this.nextHandMs : 600));
    }
    await this.persist();
    this.broadcast();
  }

  private async startNextHand() {
    const p = this.p!;
    const t = p.t;
    const id = p.tableId;
    p.turnDeadline = null;
    p.ready = [];

    // 1. Stand up players who are leaving, disconnected or out of chips; bots that are nearly broke
    for (let i = 0; i < SEAT_COUNT; i++) {
      const s = t.seats[i];
      if (!s) continue;
      if (s.cashedOut) { t.seats[i] = null; continue; } // left during the last hand and already paid out
      const here = !s.leaving && this.connected(s.userId);
      if (this.unlimited && !s.isBot && s.stack === 0 && here) {
        // Demo: re-buy (minted for the demo) instead of being sent back to the lobby
        const r = await transfer(this.env.DB, "mint", `table:${id}`, BUY_IN, `rebuy:${id}:${s.userId}:${randomHex(6)}`, "demo-buyin");
        if (r === "ok") {
          s.stack = BUY_IN;
          this.log(`${s.name} re-buys for ${BUY_IN}`);
          continue;
        }
      }
      if (!s.isBot && (!here || s.stack === 0)) await this.standUp(i, here ? "busted" : "left");
      else if (s.isBot && s.stack < BIG_BLIND * 2) await this.standUp(i, "rebuy");
    }

    // 2. Seat waiting players (a human always takes a bot's seat)
    for (const w of [...p.waiting]) {
      p.waiting = p.waiting.filter((x) => x.userId !== w.userId);
      if (!this.connected(w.userId)) continue;
      let i = t.seats.findIndex((s) => !s);
      if (i < 0) {
        i = t.seats.findIndex((s) => s?.isBot);
        if (i >= 0) await this.standUp(i, "replaced");
      }
      if (i < 0) { p.waiting.push(w); continue; }
      const ref = `buyin:${id}:${w.userId}:${randomHex(6)}`;
      // The demo mints each buy-in, so balances never run down; otherwise it comes out of the player's balance
      const r = this.unlimited
        ? await transfer(this.env.DB, "mint", `table:${id}`, BUY_IN, ref, "demo-buyin")
        : await transfer(this.env.DB, `user:${w.userId}`, `table:${id}`, BUY_IN, ref, "buyin");
      if (r === "insufficient") {
        for (const ws of this.sockets(w.userId)) {
          this.send(ws, { type: "error", message: `You need ${BUY_IN} chips to sit down. Claim your daily chips in the lobby.` });
          ws.close(4002, "insufficient");
        }
        continue;
      }
      t.seats[i] = newSeat(w.userId, w.name, false, BUY_IN, ref);
      this.log(`${w.name} sits down with ${BUY_IN}`);
    }

    // 3. No people left: bots cash out and the table goes quiet (no alarms, no cost)
    if (!t.seats.some((s) => s && !s.isBot)) {
      await Promise.all(t.seats.map((s, i) => (s?.isBot ? this.standUp(i, "idle") : null)));
      t.hand = null;
      p.next = null;
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast();
      await this.reportLobby();
      return;
    }

    // 4. Bots fill any empty seats (always labelled as bots)
    const buyIns: Promise<unknown>[] = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      if (t.seats[i]) continue;
      p.botSeq++;
      const botId = `bot:${id}:${p.botSeq}`;
      const ref = `buyin:${id}:${botId}`;
      buyIns.push(transfer(this.env.DB, "bots", `table:${id}`, BUY_IN, ref, "bot-buyin"));
      t.seats[i] = newSeat(botId, BOT_NAMES[p.botSeq % BOT_NAMES.length], true, BUY_IN, ref);
    }
    await Promise.all(buyIns);

    // 5. Shuffle, publish the deck fingerprint, deal
    const deck = secureShuffle(freshDeck());
    const salts = deck.map(() => randomHex(8));
    const { commit, leaves } = await commitDeck(deck, salts);
    p.leaves = leaves;
    if (!startHand(t, deck, salts, commit)) {
      await this.persist();
      this.broadcast();
      return;
    }
    const h = t.hand!;
    this.log(`Hand #${h.no} · deck fingerprint ${commit.slice(0, 12)}…`);
    this.log(`Blinds ${h.actions[0].amount}/${h.actions[1].amount} · ${t.seats[h.button]!.name} has the button`);
    await this.reportLobby();
    await this.afterChange();
  }

  private async standUp(i: number, reason: string) {
    const p = this.p!;
    const s = p.t.seats[i];
    if (!s) return;
    const amount = s.stack;
    if (amount > 0) {
      const to = s.isBot ? "bots" : `user:${s.userId}`;
      const r = await transfer(this.env.DB, `table:${p.tableId}`, to, amount, `cashout:${s.sitRef}`, "cashout");
      if (r === "insufficient") throw new Error(`Ledger mismatch cashing out ${s.userId}`);
    }
    const h = p.t.hand;
    if (h && !h.result && s.inHand) {
      // Mid-hand: pay out the stack now but keep the seat until the hand ends, so the chips this
      // player already put in stay in the pot (removing the seat would drop them from the pots)
      s.stack = 0;
      s.cashedOut = true;
    } else {
      p.t.seats[i] = null;
    }
    if (!s.isBot) {
      this.log(reason === "busted" ? `${s.name} is out of chips` : `${s.name} left with ${amount.toLocaleString("en-GB")}`);
      for (const ws of this.sockets(s.userId)) {
        this.send(ws, { type: "stood", amount });
        ws.close(1000, reason);
      }
    }
  }

  private async finalizeHand() {
    const p = this.p!;
    const t = p.t;
    const h = t.hand!;
    const r = h.result!;
    r.payouts.forEach((amt, i) => {
      if (amt <= 0) return;
      const shown = r.shown[i];
      this.log(`${t.seats[i]?.name ?? "Player"} wins ${amt.toLocaleString("en-GB")}${shown ? ` with ${withArticle(shown.hand)}` : ""}`);
    });
    if (r.rake > 0) this.log(`House fee ${r.rake}`);
    const id = p.tableId;
    // Three independent writes: run them together and log any that fail
    const writes = await Promise.allSettled([
      r.rake > 0 ? transfer(this.env.DB, `table:${id}`, "house", r.rake, `rake:${id}:${h.no}`, "rake") : null,
      this.env.HANDS.put(`hands/${id}/${String(h.no).padStart(7, "0")}.json`, JSON.stringify(historyOf(id, t)), {
        httpMetadata: { contentType: "application/json" },
      }),
      this.env.DB.prepare("INSERT OR IGNORE INTO hands (table_id, hand_no, ended_at, pot, rake, players) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, h.no, Date.now(), potTotal(t), r.rake, JSON.stringify(h.startSeats.filter(Boolean).map((s) => s!.userId)))
        .run(),
    ]);
    for (const w of writes) if (w.status === "rejected") console.error("finalizeHand", w.reason);
    h.finalized = true;
  }

  // ------------------------------------------------------------------ what each player sees
  private view(userId: string) {
    const p = this.p!;
    const t = p.t;
    const h = t.hand;
    const you = this.seatOf(userId);
    return {
      type: "state",
      tableId: p.tableId,
      turnSeconds: this.turnMs / 1000,
      you: {
        seat: you, waiting: p.waiting.some((w) => w.userId === userId), ready: !!p.ready?.includes(userId),
        topUp: you >= 0 && this.betweenHands() ? Math.max(0, BUY_IN - t.seats[you]!.stack) : 0,
      },
      // Between hands: how long until the next deal, so the table can show a countdown
      next: h?.result && p.next?.kind === "hand" ? { inMs: Math.max(0, p.next.at - Date.now()), totalMs: this.nextHandMs } : null,
      seats: t.seats.map((s, i) =>
        s && {
          name: s.name, isBot: s.isBot, you: i === you, stack: s.stack, bet: s.bet, total: s.total,
          folded: s.folded, allIn: s.allIn, inHand: s.inHand, connected: s.isBot || this.connected(s.userId),
          cosmetics: s.isBot ? BOT_COSMETICS : (p.cosmetics?.[s.userId] ?? BOT_COSMETICS),
          hole: this.visibleHole(i, you),
        },
      ),
      hand: h && {
        no: h.no, street: h.street, board: h.board, pot: potTotal(t), currentBet: h.currentBet, toAct: h.toAct,
        button: h.button, commit: h.commit, deadline: h.result || t.seats[h.toAct]?.isBot ? null : p.turnDeadline,
        result: h.result, reveal: h.result ? this.reveal(userId) : null,
      },
      legal: you >= 0 && h && !h.result ? legalActions(t, you) : null,
      log: p.log.slice(-14),
    };
  }

  /** Never send another player's cards unless they were shown at showdown. */
  private visibleHole(i: number, you: number): string[] {
    const t = this.p!.t;
    const s = t.seats[i]!;
    const h = t.hand;
    if (!h || !s.inHand) return [];
    if (i === you) return s.hole;
    if (s.folded) return [];
    if (h.result?.shown[i]) return s.hole;
    return h.result ? [] : ["??", "??"];
  }

  /** Per-player proof: the cards this player was allowed to see, plus commitments for the rest. */
  private reveal(userId: string): RevealItem[] | null {
    const p = this.p!;
    const h = p.t.hand!;
    if (!h.result || !p.leaves) return null;
    const me = this.seatOf(userId);
    return revealFor(h, p.leaves, me >= 0 ? p.t.seats[me]!.hole : []);
  }

  private async loadCosmetics(userId: string) {
    try {
      (this.p!.cosmetics ??= {})[userId] = await tableCosmetics(this.env.DB, userId);
    } catch (e) {
      console.error("cosmetics", e);
    }
  }

  // ------------------------------------------------------------------ helpers
  /** The seat a user is playing in (a seat they've already cashed out of mid-hand doesn't count). */
  private seatOf(userId: string) { return this.p ? this.p.t.seats.findIndex((s) => s?.userId === userId && !s.cashedOut) : -1; }
  private humans() { return this.p ? this.p.t.seats.filter((s) => s && !s.isBot).length + this.p.waiting.length : 0; }
  private sockets(userId: string, except?: WebSocket) {
    return this.ctx.getWebSockets(userId).filter((w) => w !== except && w.readyState === WebSocket.OPEN);
  }
  private connected(userId: string, except?: WebSocket) { return this.sockets(userId, except).length > 0; }
  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ } }
  private broadcast() {
    if (!this.p) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = ws.deserializeAttachment() as Attachment;
      this.send(ws, this.view(att.userId));
    }
  }
  private log(line: string) {
    this.p!.log.push(line);
    if (this.p!.log.length > 40) this.p!.log.splice(0, this.p!.log.length - 40);
  }
  private async schedule(kind: "hand" | "act", at: number) {
    this.p!.next = { kind, at };
    await this.ctx.storage.setAlarm(at);
  }
  private async persist() { if (this.p) await this.ctx.storage.put("p", this.p); }
  private async reportLobby() {
    try {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby")).report(this.p!.tableId, this.humans());
    } catch (e) {
      console.error("lobby report", e);
    }
  }
}
