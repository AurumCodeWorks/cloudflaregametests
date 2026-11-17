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
  act, BIG_BLIND, BUY_IN, DEFAULT_RAKE, SMALL_BLIND, historyOf, legalActions, newSeat, newTable, potTotal, revealFor, SEAT_COUNT, startHand, timeoutAction,
} from "./holdem.ts";
import type { Action, ActionRecord, RakeRule, TableState } from "./holdem.ts";
import { BOT_NAMES, botView, decide } from "./bot.ts";
import { permutationFrom } from "../public/fair.js";
import { transfer } from "./ledger.ts";
import type { TransferResult } from "./ledger.ts";
import { tableCosmetics } from "./shop.ts";
import type { TableSummary } from "./lobby.ts";

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
  botPlan?: { hand: number; step: number; seat: number; action: Action } | null; // the bot's move, decided when its turn began
  // The next hand's deck, committed before any player seed arrives; seeds are collected until the deal
  pending?: { serverDeck: string[]; salts: string[]; leaves: string[]; commit: string; seeds: Record<string, string> } | null;
  moves?: Move[]; // chip movements saved before their ledger transfer, so a restart can finish them
  lastPot?: number; // the last finished hand's pot, for the lobby list
}
/**
 * A chip movement between a seat and the ledger ("in": buy-in, top-up, re-buy; "out": cash-out). It is saved
 * with the table before the ledger transfer runs, and applied to the seat after. If the table restarts in
 * between, recover() retries the same transfer: its ref makes a retry safe (it can never apply twice).
 */
interface Move { seat: number; userId: string; ref: string; from: string; to: string; amount: number; kind: string; dir: "in" | "out"; fresh?: boolean }
const BOT_COSMETICS = { deck: "modern", celebration: "glow" };
interface Attachment { userId: string; name: string; windowStart: number; count: number; watch?: boolean }
const MAX_WATCHERS = 20;
const LOBBY_REPORT_MS = 5000; // pot/street updates to the lobby list at most this often (seat changes go at once)

const ACTIONS = new Set(["fold", "check", "call", "raise", "allin"]);
const MAX_MSGS_PER_SECOND = 20;
const READY_DEAL_MS = 700; // when everyone presses Continue, deal after this short beat
const SUIT: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const cardText = (c: string) => (c[0] === "T" ? "10" : c[0]) + SUIT[c[1]];
const withArticle = (hand: string) => (/^[AEIOU]/i.test(hand) ? `an ${hand.toLowerCase()}` : `a ${hand.toLowerCase()}`);

export class Table extends DurableObject<Env> {
  private p: Persisted | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private recovered = false;
  private crashAfter: string | null = null; // test hook, see testCrashAfter()
  private lastReport = { at: 0, key: "" }; // lobby-report throttle

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeat: answered by the platform without waking the table, so it costs nothing
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.p = (await ctx.storage.get<Persisted>("p")) ?? null;
    });
  }

  // ------------------------------------------------------------------ config
  private get turnMs() { return Number(this.env.TURN_SECONDS ?? 20) * 1000; }
  private get nextHandMs() { return Number(this.env.NEXT_HAND_MS ?? 5500); }
  private get unlimited() { return this.env.UNLIMITED === "1"; }
  /** How long a disconnected player's seat (and chips) are held for them to come back. */
  private get awayMs() { return Number(this.env.AWAY_SECONDS ?? 180) * 1000; }
  /** Bots "think" longer over close calls and act quickly on obvious ones. */
  private botDelay(difficulty: number) { return Number(this.env.BOT_DELAY_MS ?? 1100) * (0.55 + 0.9 * difficulty) * (0.85 + Math.random() * 0.3); }
  /** Decide a bot's move once, when its turn begins. The bot sees only what a person in its seat could. */
  private planBot(seat: number) {
    const h = this.p!.t.hand!;
    const view = botView(this.p!.t, seat, BIG_BLIND);
    const d = view ? decide(view) : { action: { type: "fold" } as Action, difficulty: 0 };
    this.p!.botPlan = { hand: h.no, step: h.actions.length, seat, action: d.action };
    return d;
  }
  private rakeRule(): RakeRule {
    const percent = Number(this.env.RAKE_PERCENT ?? 0);
    return percent > 0 ? { ...DEFAULT_RAKE, percent } : { percent: 0, cap: 0, noFlopNoDrop: true };
  }

  /** Run state-changing work one at a time, even across awaits on D1/R2 (which open the input gate). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const step = () => this.recover().then(fn); // first, finish anything a restart interrupted
    const next = this.chain.then(step, step);
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
    const watch = req.headers.get("X-Watch") === "1";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (watch) {
      // Watching: the public view only (no hidden cards), never queued for a seat, limited per table
      if (this.ctx.getWebSockets("watch").length >= MAX_WATCHERS) return new Response("Too many watchers", { status: 429 });
      this.ctx.acceptWebSocket(server, [userId, "watch"]);
      server.serializeAttachment({ userId, name, windowStart: Date.now(), count: 0, watch: true } satisfies Attachment);
      await this.run(async () => {
        if (!this.p) { this.send(server, { type: "error", message: "That table isn't running right now." }); server.close(4004, "no table"); return; }
        this.send(server, this.view(userId));
        this.ctx.waitUntil(this.reportLobby(true));
      });
      return new Response(null, { status: 101, webSocket: client });
    }
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
      if (s.awaySince) this.log(`${s.name} is back`);
      s.leaving = false;
      s.timeouts = 0;
      s.awaySince = null;
      s.sittingOut = false; // dealt in again from the next hand
      const h = p.t.hand;
      if (h && !h.result && h.toAct === seat) { // reconnected on your turn: the full timer again
        p.turnDeadline = Date.now() + this.turnMs;
        await this.schedule("act", p.turnDeadline);
      }
    }
    const soon = Date.now() + 600;
    if ((!p.t.hand || p.t.hand.result) && (p.next?.kind !== "hand" || p.next.at > soon)) await this.schedule("hand", soon);
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
    let m: { type?: string; action?: string; to?: unknown; commit?: unknown; seed?: unknown };
    try { m = JSON.parse(msg); } catch { this.send(ws, { type: "error", message: "Bad message" }); return; }
    if (att.watch) return; // watchers only listen
    await this.run(async () => {
      if (!this.p) return;
      if (m.type === "action") await this.onAction(ws, att.userId, m);
      else if (m.type === "leave") await this.onLeave(att.userId);
      else if (m.type === "cosmetics") { await this.loadCosmetics(att.userId); await this.persist(); this.broadcast(); }
      else if (m.type === "ready") await this.onReady(ws, att.userId);
      else if (m.type === "topup") await this.onTopUp(ws, att.userId);
      else if (m.type === "seed") await this.onSeed(att.userId, m.commit, m.seed);
    });
  }

  async webSocketClose(ws: WebSocket, code: number) {
    // Answer the close so the browser learns at once that it's disconnected (and starts reconnecting)
    try { ws.close(code >= 3000 && code < 5000 ? code : 1000, "closed"); } catch { /* already closed */ }
    await this.onDisconnect(ws);
  }
  async webSocketError(ws: WebSocket) { await this.onDisconnect(ws); }

  private async onDisconnect(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (att.watch) { this.ctx.waitUntil(this.reportLobby(true)); return; }
    await this.run(async () => {
      const p = this.p;
      if (!p || this.connected(att.userId, ws)) return;
      p.waiting = p.waiting.filter((w) => w.userId !== att.userId);
      // A seated player who disconnects keeps their seat and chips for a grace period. They finish the
      // current hand with the normal turn timer, then sit out (no blinds, no auto-folds) until they're back.
      const seat = this.seatOf(att.userId);
      if (seat >= 0 && !p.t.seats[seat]!.awaySince) {
        p.t.seats[seat]!.awaySince = Date.now();
        this.log(`${att.name} lost connection · seat held for ${Math.round(this.awayMs / 60000)} min`);
      }
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

  /** A player's random contribution to the next shuffle: one per person, for the deck committed right now. */
  private async onSeed(userId: string, commit: unknown, seed: unknown) {
    const pend = this.p!.pending;
    if (!pend || commit !== pend.commit || typeof seed !== "string" || !/^[0-9a-f]{32}$/.test(seed)) return;
    if (this.seatOf(userId) < 0 && !this.p!.waiting.some((w) => w.userId === userId)) return;
    if (pend.seeds[userId]) return; // can't be swapped once given
    pend.seeds[userId] = seed;
    await this.persist();
  }

  /** Shuffle and commit to the next hand's deck now, so players can add their seeds before the deal. */
  private async prepareDeck() {
    const serverDeck = secureShuffle(freshDeck());
    const salts = serverDeck.map(() => randomHex(8));
    const { commit, leaves } = await commitDeck(serverDeck, salts);
    this.p!.pending = { serverDeck, salts, leaves, commit, seeds: {} };
  }

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
    const [r] = await this.moveChips([{
      seat, userId, ref, from: this.unlimited ? "mint" : `user:${userId}`, to: `table:${p.tableId}`, amount,
      kind: this.unlimited ? "demo-topup" : "topup", dir: "in",
    }]);
    if (r === "insufficient") return this.send(ws, { type: "error", message: `You need ${amount} chips in your balance to top up` });
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
          const plan = p.botPlan;
          const fresh = plan && plan.hand === h.no && plan.step === h.actions.length && plan.seat === seat;
          const action = fresh ? plan.action : this.planBot(seat).action;
          p.botPlan = null;
          if (this.apply(() => act(p.t, seat, action))) this.apply(() => act(p.t, seat, legalActions(p.t, seat)!.check ? { type: "check" } : { type: "fold" }));
        } else if (Date.now() >= (p.turnDeadline ?? 0) - 50) {
          this.apply(() => { timeoutAction(p.t, seat); });
          this.log(`${s.name} ran out of time`);
          if (s.timeouts >= 2 && this.connected(s.userId)) s.leaving = true; // idle while connected: stand up next hand
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
        // Plan once per turn; if this turn is already planned and timed, leave its timer alone
        const plan = p.botPlan;
        const planned = plan && plan.hand === h.no && plan.step === h.actions.length && plan.seat === h.toAct && p.next?.kind === "act";
        if (!planned) await this.schedule("act", now + this.botDelay(this.planBot(h.toAct).difficulty));
      } else {
        // A dropped player gets one turn's worth of time counted from when they dropped (they usually reconnect
        // within seconds); once that's used up, their later turns act at once instead of holding everyone up
        const awayFor = s.awaySince && !this.connected(s.userId) ? now - s.awaySince : 0;
        p.turnDeadline = now + Math.max(1000, this.turnMs - awayFor);
        await this.schedule("act", p.turnDeadline);
      }
    } else if (p.next?.kind !== "hand") {
      // Hand over (or none yet): replace any leftover turn timer, which would otherwise hold up the next deal
      await this.schedule("hand", now + (h?.result ? this.nextHandMs : 600));
    }
    await this.persist();
    this.broadcast();
    this.ctx.waitUntil(this.reportLobby()); // throttled: the lobby list's pot and stage
  }

  private async startNextHand() {
    const p = this.p!;
    const t = p.t;
    const id = p.tableId;
    p.turnDeadline = null;
    p.ready = [];

    // 1. Who plays this hand. Players who left, or who've been disconnected longer than the grace
    //    period, stand up with their chips paid back to their balance; a disconnected player inside the
    //    grace period keeps the seat but sits out; bots that are nearly broke make way for fresh ones.
    const now = Date.now();
    for (let i = 0; i < SEAT_COUNT; i++) {
      const s = t.seats[i];
      if (!s) continue;
      if (s.cashedOut) { t.seats[i] = null; continue; } // left during the last hand and already paid out
      if (s.isBot) { if (s.stack < BIG_BLIND * 2) await this.standUp(i, "rebuy"); continue; }
      const online = this.connected(s.userId);
      if (online) { s.awaySince = null; s.sittingOut = false; }
      else { s.awaySince ??= now; s.sittingOut = true; }
      if (s.leaving || (s.awaySince && now - s.awaySince >= this.awayMs)) { await this.standUp(i, "left"); continue; }
      if (s.stack === 0 && online) {
        if (this.unlimited) {
          // Demo: re-buy (minted for the demo) instead of being sent back to the lobby
          const [r] = await this.moveChips([{ seat: i, userId: s.userId, ref: `rebuy:${id}:${s.userId}:${randomHex(6)}`, from: "mint", to: `table:${id}`, amount: BUY_IN, kind: "demo-buyin", dir: "in" }]);
          if (r !== "insufficient") { this.log(`${s.name} re-buys for ${BUY_IN}`); continue; }
        }
        await this.standUp(i, "busted");
      }
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
      // The seat is taken (with no chips yet) before the buy-in moves, so a restart can't strand the chips.
      // The demo mints each buy-in, so balances never run down; otherwise it comes out of the player's balance.
      t.seats[i] = newSeat(w.userId, w.name, false, 0, ref);
      const [r] = await this.moveChips([{
        seat: i, userId: w.userId, ref, from: this.unlimited ? "mint" : `user:${w.userId}`, to: `table:${id}`, amount: BUY_IN,
        kind: this.unlimited ? "demo-buyin" : "buyin", dir: "in", fresh: true,
      }]);
      if (r === "insufficient") {
        for (const ws of this.sockets(w.userId)) {
          this.send(ws, { type: "error", message: `You need ${BUY_IN} chips to sit down. Claim your daily chips in the lobby.` });
          ws.close(4002, "insufficient");
        }
        continue;
      }
      this.log(`${w.name} sits down with ${BUY_IN}`);
    }

    // 3. Nobody here to play: bots cash out and the table goes quiet. If seats are being held for
    //    disconnected players, wake up once when the earliest hold runs out; otherwise no alarm, no cost.
    if (!t.seats.some((s) => s && !s.isBot && !s.sittingOut)) {
      await Promise.all(t.seats.map((s, i) => (s?.isBot ? this.standUp(i, "idle") : null)));
      t.hand = null;
      p.next = null;
      const held = t.seats.filter((s) => s && !s.isBot && s.awaySince).map((s) => s!.awaySince! + this.awayMs);
      if (held.length) await this.schedule("hand", Math.min(...held) + 500);
      else await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast();
      await this.reportLobby();
      return;
    }

    // 4. Bots fill any empty seats (always labelled as bots)
    const botMoves: Move[] = [];
    for (let i = 0; i < SEAT_COUNT; i++) {
      if (t.seats[i]) continue;
      p.botSeq++;
      const botId = `bot:${id}:${p.botSeq}`;
      const ref = `buyin:${id}:${botId}`;
      t.seats[i] = newSeat(botId, BOT_NAMES[p.botSeq % BOT_NAMES.length], true, 0, ref);
      botMoves.push({ seat: i, userId: botId, ref, from: "bots", to: `table:${id}`, amount: BUY_IN, kind: "bot-buyin", dir: "in", fresh: true });
    }
    if (botMoves.length) await this.moveChips(botMoves);

    // 5. Deal from the deck the house committed to, reordered by the players' seeds
    if (!p.pending) await this.prepareDeck();
    const pend = p.pending!;
    const seeds = Object.values(pend.seeds).sort();
    const perm = await permutationFrom(pend.commit, seeds);
    const deck = perm.map((j) => pend.serverDeck[j]);
    p.leaves = pend.leaves;
    if (!startHand(t, deck, pend.salts, pend.commit, { serverDeck: pend.serverDeck, seeds })) {
      // Fewer than two players can be dealt in: seats held for disconnected players can't take bots. Wake up
      // when the first hold runs out (bots can then sit), or shortly if nothing is held, and try again.
      const held = t.seats.filter((x) => x && !x.isBot && x.awaySince).map((x) => x!.awaySince! + this.awayMs);
      await this.schedule("hand", held.length ? Math.min(...held) + 500 : Date.now() + 5000);
      await this.persist();
      this.broadcast();
      return;
    }
    p.pending = null;
    const h = t.hand!;
    this.log(`Hand #${h.no} · deck fingerprint ${pend.commit.slice(0, 12)}… · ${seeds.length} player seed${seeds.length === 1 ? "" : "s"} mixed in`);
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
      // Paid back to the player's balance (the seat clears when the move settles, see settle())
      const to = s.isBot ? "bots" : `user:${s.userId}`;
      await this.moveChips([{ seat: i, userId: s.userId, ref: `cashout:${s.sitRef}`, from: `table:${p.tableId}`, to, amount, kind: "cashout", dir: "out" }]);
    } else {
      this.clearSeat(i);
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
    p.lastPot = potTotal(t);
    h.finalized = true;
  }

  // ------------------------------------------------------------------ chip movements (crash-safe)
  /** Save the moves with the table, then run their ledger transfers, then apply them to the seats. */
  private async moveChips(list: Move[]): Promise<TransferResult[]> {
    const p = this.p!;
    p.moves = [...(p.moves ?? []), ...list];
    await this.persist(); // the intent is saved before any chips move
    const results = await Promise.all(list.map((m) => transfer(this.env.DB, m.from, m.to, m.amount, m.ref, m.kind)));
    if (this.crashAfter && list.some((m) => m.kind === this.crashAfter)) {
      this.crashAfter = null;
      this.ctx.abort("test: crash between a ledger transfer and saving the table");
    }
    list.forEach((m, i) => this.settle(m, results[i]));
    return results;
  }
  /** Apply a finished transfer to its seat. "duplicate" means it had already gone through: apply it the same way. */
  private settle(m: Move, r: TransferResult) {
    const p = this.p!;
    p.moves = (p.moves ?? []).filter((x) => x.ref !== m.ref);
    const s = p.t.seats[m.seat];
    if (!s || s.userId !== m.userId) return;
    if (m.dir === "in") {
      if (r === "insufficient") { if (m.fresh) p.t.seats[m.seat] = null; return; }
      s.stack += m.amount;
      return;
    }
    if (r === "insufficient") console.error(`ledger mismatch cashing out ${m.userId}`);
    s.stack = 0;
    this.clearSeat(m.seat);
  }
  /** Free a seat. Mid-hand the seat stays (cashed out) until the hand ends, so chips already in the pot stay there. */
  private clearSeat(i: number) {
    const p = this.p!;
    const s = p.t.seats[i];
    const h = p.t.hand;
    if (s && h && !h.result && s.inHand) { s.stack = 0; s.cashedOut = true; }
    else p.t.seats[i] = null;
  }
  /** After a restart: finish any chip movement that was saved but not applied, before anything else happens. */
  private async recover() {
    if (this.recovered) return;
    const moves = this.p?.moves ?? [];
    if (moves.length) {
      const results = await Promise.all(moves.map((m) => transfer(this.env.DB, m.from, m.to, m.amount, m.ref, m.kind)));
      moves.forEach((m, i) => this.settle(m, results[i]));
      this.log(`Restart recovery: finished ${moves.length} chip movement${moves.length === 1 ? "" : "s"}; nothing was lost`);
      await this.persist();
    }
    this.recovered = true;
  }
  /** Test hook, honoured only when AUDIT=1: crash right after the next ledger transfer of this kind. */
  async testCrashAfter(kind: string) {
    if (this.env.AUDIT === "1") this.crashAfter = kind;
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
      seatHoldSeconds: this.awayMs / 1000,
      bigBlind: BIG_BLIND,
      you: {
        seat: you, waiting: p.waiting.some((w) => w.userId === userId), ready: !!p.ready?.includes(userId),
        topUp: you >= 0 && this.betweenHands() ? Math.max(0, BUY_IN - t.seats[you]!.stack) : 0,
      },
      // Between hands: how long until the next deal, so the table can show a countdown
      next: h?.result && p.next?.kind === "hand" ? { inMs: Math.max(0, p.next.at - Date.now()), totalMs: this.nextHandMs } : null,
      // The next deck's fingerprint, published before the deal so each player can add a seed to the shuffle
      nextCommit: (!h || h.result) && p.pending ? p.pending.commit : null,
      seats: t.seats.map((s, i) =>
        s && {
          name: s.name, isBot: s.isBot, you: i === you, stack: s.stack, bet: s.bet, total: s.total,
          folded: s.folded, allIn: s.allIn, inHand: s.inHand, connected: s.isBot || this.connected(s.userId),
          away: !s.isBot && !!s.awaySince, heldForMs: s.awaySince ? Math.max(0, s.awaySince + this.awayMs - Date.now()) : null,
          cosmetics: s.isBot ? BOT_COSMETICS : (p.cosmetics?.[s.userId] ?? BOT_COSMETICS),
          hole: this.visibleHole(i, you),
        },
      ),
      hand: h && {
        no: h.no, street: h.street, board: h.board, pot: potTotal(t), currentBet: h.currentBet, toAct: h.toAct, seeds: h.seeds ?? [],
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
    if (kind === "hand" && !this.p!.pending) await this.prepareDeck(); // commit before players add their seeds
    await this.ctx.storage.setAlarm(at);
  }
  private async persist() { if (this.p) await this.ctx.storage.put("p", this.p); }
  /** What the lobby list shows for this table. */
  private summary(): TableSummary {
    const p = this.p!, t = p.t, h = t.hand;
    const people = t.seats.filter((s) => s && !s.isBot && !s.cashedOut);
    const live = !!h && !h.result;
    return {
      id: p.tableId, people: people.length, away: people.filter((s) => s!.awaySince).length, bots: t.seats.filter((s) => s?.isBot).length,
      waiting: p.waiting.length, watchers: this.ctx.getWebSockets("watch").length, seats: SEAT_COUNT, blinds: [SMALL_BLIND, BIG_BLIND], buyIn: BUY_IN,
      pot: live ? potTotal(t) : 0, street: live ? h!.street : null, handNo: h?.no ?? 0, lastPot: p.lastPot ?? 0, updatedAt: Date.now(),
    };
  }
  /** Tell the lobby who's here (at once when that changes) and the table's pot and stage (at most every few seconds). */
  private async reportLobby(force = false) {
    try {
      const p = this.p;
      if (!p) return;
      const members = [...p.t.seats.filter((s) => s && !s.isBot && !s.cashedOut).map((s) => s!.userId), ...p.waiting.map((w) => w.userId)];
      const summary = this.summary();
      // Who's here and in what state goes at once; the pot and stage at most every few seconds
      const key = [members.join(","), summary.people, summary.waiting, summary.away, summary.bots, summary.watchers].join("|");
      const now = Date.now();
      if (!force && key === this.lastReport.key && now - this.lastReport.at < LOBBY_REPORT_MS) return;
      this.lastReport = { at: now, key };
      await this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby")).report(p.tableId, this.humans(), members, summary);
    } catch (e) {
      console.error("lobby report", e);
    }
  }
}
