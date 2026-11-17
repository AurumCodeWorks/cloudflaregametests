// Worker entry: the website, a small JSON API, and the WebSocket door into each table.
import { Lobby, TABLE_ID } from "./lobby.ts";
import { Table } from "./table.ts";
import type { Env } from "./env.ts";
import { balance, topUp, transfer } from "./ledger.ts";
import { randomHex } from "./cards.ts";
import { FILES } from "./generated/assets.ts";
import { buy, equip, shopState } from "./shop.ts";

export { Lobby, Table };

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface User { id: string; name: string }

async function authenticate(req: Request, env: Env): Promise<User | null> {
  const url = new URL(req.url);
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  return env.DB.prepare("SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").bind(token).first<User>();
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 16) return null;
  if (/\bbot\b/i.test(name)) return null; // "bot" is reserved so computer players can't be impersonated
  return name;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // -------------------------------------------------------------- API
    if (path === "/api/login" && req.method === "POST") {
      if (env.LOGIN_LIMIT) {
        const { success } = await env.LOGIN_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") ?? "local" });
        if (!success) return json({ error: "Too many new accounts from your connection. Try again in a minute." }, 429);
      }
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      const name = cleanName(body.name);
      if (!name) return json({ error: "Pick a name of 2-16 characters (names containing 'bot' are reserved)." }, 400);
      const id = crypto.randomUUID();
      const token = randomHex(24);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, now),
        env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").bind(token, id, now),
      ]);
      await transfer(env.DB, "mint", `user:${id}`, Number(env.STARTING_CHIPS ?? 1000), `grant:${id}`, "grant");
      return json({ token, userId: id, name });
    }

    if (path.startsWith("/api/") || path.startsWith("/ws/")) {
      const user = await authenticate(req, env);
      if (!user) return json({ error: "Please sign in again." }, 401);

      const unlimited = env.UNLIMITED === "1";
      const lobby = () => env.LOBBY.get(env.LOBBY.idFromName("lobby"));
      if (path === "/api/me") {
        const [bal, table] = await Promise.all([
          unlimited ? topUp(env.DB, `user:${user.id}`) : balance(env.DB, `user:${user.id}`),
          lobby().whereIs(user.id), // the table you're seated at (or held for you), so you can get straight back to it
        ]);
        return json({ userId: user.id, name: user.name, balance: bal, unlimited, table });
      }

      if (path === "/api/daily" && req.method === "POST") {
        if (unlimited) return json({ error: "Chips are unlimited in the demo." }, 400);
        // Free-play top-up: once a day, only when you're running low
        const bal = await balance(env.DB, `user:${user.id}`);
        if (bal >= 500) return json({ error: "Daily chips are for balances under 500." }, 400);
        const day = new Date().toISOString().slice(0, 10);
        const r = await transfer(env.DB, "mint", `user:${user.id}`, 1000, `daily:${user.id}:${day}`, "daily");
        if (r === "duplicate") return json({ error: "You've already claimed today's chips." }, 400);
        return json({ balance: await balance(env.DB, `user:${user.id}`) });
      }

      // ------------------------------------------------------------ cosmetics shop
      // The demo unlocks everything free, whatever the payments setting
      const mode = unlimited ? "test" : env.PAYMENTS_MODE ?? "test";
      if (path === "/api/shop" && req.method === "GET") return json({ ...(await shopState(env.DB, user.id, mode)), unlimited });
      if ((path === "/api/shop/buy" || path === "/api/shop/equip") && req.method === "POST") {
        const { itemId } = (await req.json().catch(() => ({}))) as { itemId?: unknown };
        if (typeof itemId !== "string" || itemId.length > 64) return json({ error: "Bad item." }, 400);
        const r = path.endsWith("/buy") ? await buy(env.DB, user.id, itemId, mode) : await equip(env.DB, user.id, itemId);
        if (!r.ok) return json({ error: r.error }, r.status);
        return json({ granted: r.granted, ...(await shopState(env.DB, user.id, mode)), unlimited });
      }

      if (path === "/api/play" && req.method === "POST") {
        // Already seated somewhere (or a seat is being held for you)? Back to that table, never a second seat.
        // Otherwise: a table picked from the list or a private link, a new private table, or quick seat.
        const body = (await req.json().catch(() => ({}))) as { tableId?: unknown; private?: unknown };
        const current = await lobby().whereIs(user.id);
        if (current) return json({ tableId: current, rejoined: true });
        if (typeof body.tableId === "string" && TABLE_ID.test(body.tableId)) return json({ tableId: body.tableId });
        if (body.private === true) return json({ tableId: await lobby().createPrivate(), private: true });
        return json({ tableId: await lobby().assign() });
      }

      // The live table list (one hibernating WebSocket per viewer; updates are pushed)
      if (path === "/ws/lobby") {
        if (req.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
        return lobby().fetch(req);
      }

      // Test hook (AUDIT=1 only): make a table crash right after its next ledger transfer of a given kind
      const crash = path.match(/^\/api\/debug\/crash\/(t-[0-9a-f]{8}|p-[0-9a-f]{16})$/);
      if (crash && env.AUDIT === "1" && req.method === "POST") {
        const { kind } = (await req.json().catch(() => ({}))) as { kind?: string };
        await env.TABLE.get(env.TABLE.idFromName(crash[1])).testCrashAfter(String(kind ?? "buyin"));
        return json({ ok: true });
      }

      const ws = path.match(/^\/ws\/table\/(t-[0-9a-f]{8}|p-[0-9a-f]{16})$/);
      if (ws) {
        if (req.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
        const headers = new Headers(req.headers);
        headers.set("X-User-Id", user.id); // set by us, never trusted from the client
        headers.set("X-User-Name", user.name);
        headers.set("X-Table-Id", ws[1]);
        headers.set("X-Watch", url.searchParams.get("watch") === "1" ? "1" : "0"); // never trusted from the client's own headers
        return env.TABLE.get(env.TABLE.idFromName(ws[1])).fetch(new Request(req, { headers }));
      }

      const hand = path.match(/^\/api\/hands\/(t-[0-9a-f]{8}|p-[0-9a-f]{16})\/(\d{1,7})$/);
      if (hand) {
        const obj = await env.HANDS.get(`hands/${hand[1]}/${hand[2].padStart(7, "0")}.json`);
        if (!obj) return json({ error: "Not found" }, 404);
        const hist = (await obj.json()) as { startSeats: ({ userId: string } | null)[] };
        if (!hist.startSeats.some((s) => s?.userId === user.id)) return json({ error: "You weren't in that hand." }, 403);
        return json(hist);
      }

      if (path === "/api/audit" && env.AUDIT === "1") {
        const { results } = await env.DB.prepare("SELECT id, balance FROM accounts ORDER BY id").all<{ id: string; balance: number }>();
        return json({ sum: results.reduce((a, r) => a + r.balance, 0), accounts: results });
      }
      return json({ error: "Not found" }, 404);
    }

    // -------------------------------------------------------------- game audio (R2)
    // Versioned paths never change, so browsers keep them for good; ranges let <audio> stream the music
    const audio = path.match(/^\/audio\/(v\d{1,3})\/([a-z0-9-]{1,40})\.mp3$/);
    if (audio && (req.method === "GET" || req.method === "HEAD")) {
      const key = `audio/${audio[1]}/${audio[2]}.mp3`;
      const obj = req.method === "HEAD" ? await env.HANDS.head(key) : await env.HANDS.get(key, { range: req.headers });
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers({ "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes", etag: obj.httpEtag, ...SECURITY_HEADERS });
      // R2 reports the range it served as {offset, length}, {offset} or {suffix}; turn it into first byte + length
      const r = (obj as R2Object).range as { offset?: number; length?: number; suffix?: number } | undefined;
      const start = r ? (r.suffix !== undefined ? obj.size - r.suffix : r.offset ?? 0) : 0;
      const length = r ? (r.suffix ?? r.length ?? obj.size - start) : obj.size;
      const partial = req.headers.has("range") && !!r && length < obj.size;
      if (partial) headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
      headers.set("content-length", String(length));
      return new Response("body" in obj ? (obj as R2ObjectBody).body : null, { status: partial ? 206 : 200, headers });
    }

    // -------------------------------------------------------------- website
    const file = FILES[path === "/" ? "/index.html" : path];
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(file.body, {
      headers: { "content-type": file.type, "cache-control": path === "/" || path.endsWith(".html") ? "no-cache" : "public, max-age=300", ...SECURITY_HEADERS },
    });
  },
} satisfies ExportedHandler<Env>;
