// One Durable Object per player for slot machines. It is the only authority for that player's seeds,
// nonce and spins, so two tabs, a reload or a reconnect can never spin the same nonce twice or see
// different seeds. There are no bots here: it is the player against a published paytable.
//
// Fairness (public/fair.js): the server seed is committed (its SHA-256 is shown) before any spin made
// with it; the player supplies a client seed; each spin's reel stops are HMAC-SHA256 of those and a
// nonce. The NEXT server seed is committed in advance too, so when the player changes seeds the new
// server seed was fixed before their new client seed existed. Changing seeds reveals the old one.
//
// Crash safety (same pattern as moveChips/recover in table.ts): the whole spin (stake, stops, payout)
// is saved here before any chips move; the ledger transfers carry refs derived from the seed number and
// nonce, so after a restart the same transfers are simply retried and can never apply twice.
//
// Cost: plain requests only. No sockets, no alarms, no polling; an idle player costs nothing.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { balance, topUp, transfer } from "./ledger.ts";
import { randomHex } from "./cards.ts";
import { CLIENT_SEED, sha256Hex, spinStops } from "../public/fair.js";
import { evaluate, formatMoney, MACHINES, MIN_SPIN_MS, reelSizes, STAKES } from "../public/machines.js";

const BANK = "slots"; // the ledger account stakes go to and payouts come from
const BANK_FLOAT = 1_000_000; // minted into the bank when a payout needs it (its own ledger entry, so the books balance)
const SESSION_IDLE_MS = 30 * 60 * 1000; // a session left idle this long is over; the next spin starts a new one
const HISTORY_LIMIT = 2000; // spins returned per seed for re-verification

interface Spin {
  rid: string; // the browser's id for this press, so a retried request can never become a second spin
  seedNo: number; nonce: number; machine: string; stake: number; stops: number[]; payout: number; at: number;
}
interface Session { startedAt: number; lastAt: number; spins: number; staked: number; returned: number }
interface Persisted {
  userId: string;
  seedNo: number; // counts this player's server seeds: 1, 2, 3...
  serverSeed: string; commit: string; // in use now (secret until rotated)
  nextServerSeed: string; nextCommit: string; // committed in advance for the next rotation
  clientSeed: string | null;
  nonce: number; // spins completed with the current seed pair
  lastSpinAt: number;
  session: Session | null;
  pending: Spin | null; // saved before its ledger transfers; finished by recover() after a restart
  last: (Spin & { balance: number }) | null; // the last finished spin, replayed if the same press is sent again
}
export type SlotResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; retryInMs?: number };

export class SlotSession extends DurableObject<Env> {
  private p: Persisted | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private recovered = false;
  private crashAfter: string | null = null; // test hook, see testCrashAfter()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.p = (await ctx.storage.get<Persisted>("p")) ?? null;
    });
  }

  private get unlimited() { return this.env.UNLIMITED === "1"; }
  private async persist() { if (this.p) await this.ctx.storage.put("p", this.p); }
  private async newSeed() { const seed = randomHex(32); return { seed, commit: await sha256Hex(seed) }; }

  /** One thing at a time, even across awaits on D1 (which let other requests in); recovery always first. */
  private run<T>(userId: string, fn: (p: Persisted) => Promise<T>): Promise<T> {
    const step = async () => {
      if (!this.p) {
        const [a, b] = await Promise.all([this.newSeed(), this.newSeed()]);
        this.p = { userId, seedNo: 1, serverSeed: a.seed, commit: a.commit, nextServerSeed: b.seed, nextCommit: b.commit, clientSeed: null, nonce: 0, lastSpinAt: 0, session: null, pending: null, last: null };
        await this.persist();
      }
      await this.recover();
      return fn(this.p);
    };
    const next = this.chain.then(step, step);
    this.chain = next.catch(() => {});
    return next;
  }

  /** What the player may know: never the server seed in use, nor the next one. */
  private view(p: Persisted) {
    const now = Date.now();
    const live = p.session && now - p.session.lastAt < SESSION_IDLE_MS ? p.session : null;
    return {
      seedNo: p.seedNo, commit: p.commit, nextCommit: p.nextCommit, clientSeed: p.clientSeed, nonce: p.nonce,
      session: live, now, minSpinMs: MIN_SPIN_MS, stakes: STAKES, nextSpinInMs: Math.max(0, p.lastSpinAt + MIN_SPIN_MS - now),
    };
  }

  async state(userId: string) {
    return this.run(userId, async (p) => ({ ...this.view(p), balance: await this.wallet(userId) }));
  }
  /** The ledger balance as it is. (The demo tops a player up only when a stake needs it, see finish().) */
  private wallet(userId: string) { return balance(this.env.DB, `user:${userId}`); }

  // ------------------------------------------------------------------ spinning
  async spin(userId: string, machine: unknown, stake: unknown, rid: unknown): Promise<SlotResult<{ spin: Spin; replay: boolean } & ReturnType<SlotSession["view"]> & { balance: number }>> {
    return this.run(userId, async (p) => {
      if (typeof rid !== "string" || !/^[0-9a-f]{16,32}$/.test(rid)) return { ok: false, status: 400, error: "Bad spin request." };
      // The same press sent twice (a retry after a dropped connection): the same spin back, never a second one
      if (p.last?.rid === rid) return { ok: true, spin: p.last, replay: true, ...this.view(p), balance: p.last.balance };
      if (typeof machine !== "string" || !Object.hasOwn(MACHINES, machine) || MACHINES[machine].retired) return { ok: false, status: 400, error: "No such machine." };
      if (typeof stake !== "number" || !STAKES.includes(stake)) return { ok: false, status: 400, error: `Stakes are ${STAKES.map(formatMoney).join(", ")} of play money per spin.` };
      if (!p.clientSeed) return { ok: false, status: 409, error: "Set your seed first." };
      const now = Date.now();
      const wait = p.lastSpinAt + MIN_SPIN_MS - now;
      // One spin at a time for this player across every machine, tab and device, never faster than 2.5 s
      if (wait > 0) return { ok: false, status: 429, error: "The last spin hasn't finished yet.", retryInMs: wait };

      const nonce = p.nonce + 1;
      const stops = await spinStops({ serverSeed: p.serverSeed, clientSeed: p.clientSeed, nonce, machine, sizes: reelSizes(machine) });
      const payout = evaluate(machine, stops).mult * stake;
      p.pending = { rid, seedNo: p.seedNo, nonce, machine, stake, stops, payout, at: now };
      p.lastSpinAt = now;
      await this.persist(); // the whole spin is saved before any chips move
      const done = await this.finish(p);
      if (!done) return { ok: false, status: 402, error: `You need ${formatMoney(stake)} of play money for that spin.` };
      return { ok: true, spin: done, replay: false, ...this.view(p), balance: done.balance };
    });
  }

  /** Move the chips for the saved spin and record it. Safe to run again after a crash at any point. */
  private async finish(p: Persisted): Promise<(Spin & { balance: number }) | null> {
    const s = p.pending!;
    const db = this.env.DB;
    const user = `user:${p.userId}`;
    const ref = `slot:${p.userId}:${s.seedNo}:${s.nonce}`;
    let r = await transfer(db, user, BANK, s.stake, `${ref}:stake`, "slot-stake");
    this.maybeCrash("stake");
    if (r === "insufficient" && this.unlimited) { // demo: play money never runs out
      await topUp(db, user);
      r = await transfer(db, user, BANK, s.stake, `${ref}:stake`, "slot-stake");
    }
    if (r === "insufficient") { // nothing moved and nothing was revealed: the nonce is not used up
      p.pending = null;
      p.lastSpinAt = 0;
      await this.persist();
      return null;
    }
    if (s.payout > 0) {
      let w = await transfer(db, BANK, user, s.payout, `${ref}:payout`, "slot-payout");
      if (w === "insufficient") {
        await transfer(db, "mint", BANK, Math.max(BANK_FLOAT, s.payout), `${ref}:float`, "slots-float");
        w = await transfer(db, BANK, user, s.payout, `${ref}:payout`, "slot-payout");
      }
      if (w === "insufficient") throw new Error("slots bank could not pay"); // the spin stays pending and is retried
      this.maybeCrash("payout");
    }
    const [, bal] = await Promise.all([
      db.prepare("INSERT OR IGNORE INTO slot_spins (user_id, seed_no, nonce, machine, stake, stops, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(p.userId, s.seedNo, s.nonce, s.machine, s.stake, JSON.stringify(s.stops), s.payout, s.at).run(),
      balance(db, user),
    ]);
    const sess = p.session && s.at - p.session.lastAt < SESSION_IDLE_MS ? p.session : { startedAt: s.at, lastAt: s.at, spins: 0, staked: 0, returned: 0 };
    sess.lastAt = s.at; sess.spins++; sess.staked += s.stake; sess.returned += s.payout;
    p.session = sess;
    p.nonce = s.nonce;
    p.last = { ...s, balance: bal };
    p.pending = null;
    await this.persist();
    return p.last;
  }

  /** After a restart: finish a spin that was saved but whose chips hadn't all moved, before anything else. */
  private async recover() {
    if (this.recovered) return;
    if (this.p?.pending) await this.finish(this.p);
    this.recovered = true;
  }
  private maybeCrash(stage: string) {
    if (this.crashAfter !== stage) return;
    this.crashAfter = null;
    this.ctx.abort("test: crash between a ledger transfer and saving the spin");
  }
  /** Test hook, honoured only when AUDIT=1: crash right after the next "stake" or "payout" transfer. */
  async testCrashAfter(stage: string) { if (this.env.AUDIT === "1") this.crashAfter = stage; }

  // ------------------------------------------------------------------ seeds
  /**
   * Set the player's seed. Before the first spin of a seed pair it is simply stored (the server seed is
   * already committed). After that it rotates: the old server seed is revealed so every spin made with it
   * can be re-checked, and the seed committed in advance takes over.
   */
  async setSeed(userId: string, clientSeed: unknown): Promise<SlotResult<ReturnType<SlotSession["view"]> & { revealed: null | { seedNo: number; serverSeed: string; commit: string; clientSeed: string; spins: number } }>> {
    return this.run(userId, async (p) => {
      if (typeof clientSeed !== "string" || !CLIENT_SEED.test(clientSeed)) return { ok: false, status: 400, error: "A seed is 1-64 letters, digits, - or _." };
      if (p.nonce === 0) {
        p.clientSeed = clientSeed;
        await this.persist();
        return { ok: true, ...this.view(p), revealed: null };
      }
      const revealed = { seedNo: p.seedNo, serverSeed: p.serverSeed, commit: p.commit, clientSeed: p.clientSeed!, spins: p.nonce };
      const fresh = await this.newSeed();
      const now = Date.now();
      // Record the reveal first (idempotent), then switch: a crash in between just repeats the same reveal
      await this.env.DB.prepare("INSERT OR IGNORE INTO slot_seeds (user_id, seed_no, commit_hash, client_seed, server_seed, spins, revealed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(userId, revealed.seedNo, revealed.commit, revealed.clientSeed, revealed.serverSeed, revealed.spins, now).run();
      p.seedNo++;
      p.serverSeed = p.nextServerSeed; p.commit = p.nextCommit;
      p.nextServerSeed = fresh.seed; p.nextCommit = fresh.commit;
      p.clientSeed = clientSeed;
      p.nonce = 0;
      await this.persist();
      return { ok: true, ...this.view(p), revealed };
    });
  }

  /** Stop playing: the session's totals are returned once and cleared. */
  async stop(userId: string) {
    return this.run(userId, async (p) => {
      const ended = this.view(p).session;
      p.session = null;
      await this.persist();
      return { ended, ...this.view(p), balance: await this.wallet(userId) };
    });
  }
}

/** Spins made with one seed pair, oldest first, for re-verification in the browser. */
export async function spinHistory(db: D1Database, userId: string, seedNo: number) {
  const [{ results }, seed] = await Promise.all([
    db.prepare("SELECT nonce, machine, stake, stops, payout, created_at FROM slot_spins WHERE user_id = ? AND seed_no = ? ORDER BY nonce LIMIT ?")
      .bind(userId, seedNo, HISTORY_LIMIT).all<{ nonce: number; machine: string; stake: number; stops: string; payout: number; created_at: number }>(),
    db.prepare("SELECT seed_no, commit_hash, client_seed, server_seed, spins, revealed_at FROM slot_seeds WHERE user_id = ? AND seed_no = ?")
      .bind(userId, seedNo).first<{ seed_no: number; commit_hash: string; client_seed: string; server_seed: string; spins: number; revealed_at: number }>(),
  ]);
  return {
    seedNo,
    revealed: seed ? { seedNo: seed.seed_no, commit: seed.commit_hash, clientSeed: seed.client_seed, serverSeed: seed.server_seed, spins: seed.spins, revealedAt: seed.revealed_at } : null,
    spins: results.map((r) => ({ nonce: r.nonce, machine: r.machine, stake: r.stake, stops: JSON.parse(r.stops) as number[], payout: r.payout, at: r.created_at })),
  };
}

/** The player's revealed seed pairs, newest first. */
export async function revealedSeeds(db: D1Database, userId: string) {
  const { results } = await db.prepare("SELECT seed_no, commit_hash, client_seed, server_seed, spins, revealed_at FROM slot_seeds WHERE user_id = ? ORDER BY seed_no DESC LIMIT 20")
    .bind(userId).all<{ seed_no: number; commit_hash: string; client_seed: string; server_seed: string; spins: number; revealed_at: number }>();
  return results.map((s) => ({ seedNo: s.seed_no, commit: s.commit_hash, clientSeed: s.client_seed, serverSeed: s.server_seed, spins: s.spins, revealedAt: s.revealed_at }));
}
