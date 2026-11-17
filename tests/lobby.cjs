// Lobby list, watching and private tables. Needs the dev server. Run: node tests/lobby.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
const WSB = base.replace("http", "ws");
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, token, body) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();
async function bot(name, body = {}) { // a scripted player
  const { token } = await post("/api/login", null, { name });
  const { tableId } = await post("/api/play", token, body);
  const p = { token, tableId, states: [] };
  p.ws = new WebSocket(`${WSB}/ws/table/${tableId}?token=${token}`);
  p.ws.onmessage = (e) => { if (e.data === "pong") return; const m = JSON.parse(e.data); if (m.type !== "state") return; p.states.push(m); if (m.legal && !m.hand?.result) p.ws.send(JSON.stringify({ type: "action", action: m.legal.check ? "check" : "call" })); };
  return p;
}

(async () => {
  const browser = await chromium.launch();
  const errs = [];
  const newPage = async () => { const pg = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); pg.on("pageerror", (e) => errs.push(e.message)); return pg; };

  // A table is running (one person and bots)
  const a = await bot("Ari");
  await wait(2500);

  // 1. The lobby lists it, live
  const v = await newPage();
  await v.goto(base + "/", { waitUntil: "domcontentloaded" });
  await v.fill('[data-testid="name"]', "Vee");
  await v.click('[data-testid="login"]');
  const row = `.trow[data-table="${a.tableId}"]`;
  await v.waitForSelector(row, { timeout: 10000 }).catch(() => {});
  const rowText = (await v.textContent(row).catch(() => "")) ?? "";
  check(rowText.includes("1 person") && /bot/.test(rowText) && rowText.includes("Blinds 5/10"), `the running table is listed with its people, bots and stakes ("${rowText.replace(/\s+/g, " ").trim().slice(0, 90)}")`);
  await v.waitForFunction((sel) => /Pot \d/.test(document.querySelector(sel)?.textContent ?? ""), row, { timeout: 20000 }).catch(() => {});
  check(/Pot \d/.test((await v.textContent(row).catch(() => "")) ?? ""), "the list shows the live pot of the hand in play");

  // 2. Watch it: public view only, no console, counted as a watcher
  await v.click(`${row} [data-act="watch"]`);
  await v.waitForFunction(() => window.__poker.state?.hand && !window.__poker.state.hand.result, null, { timeout: 20000 }).catch(() => {});
  const watchView = await v.evaluate(() => ({ seat: window.__poker.state.you.seat, watching: window.__poker.watching, bar: !document.getElementById("watch-bar").hidden, console: getComputedStyle(document.getElementById("actions")).display }));
  check(watchView.watching && watchView.bar && watchView.console === "none" && watchView.seat === -1, "watching: the watch bar shows, the action console is hidden, no seat taken");
  // Watch a few updates: never a hidden card
  let leaked = false;
  for (let i = 0; i < 12; i++) {
    leaked ||= await v.evaluate(() => { const s = window.__poker.state; return s.seats.some((x, i) => x && x.hole.some((c) => c !== "??") && !s.hand?.result?.shown?.[i]); });
    await wait(400);
  }
  check(!leaked, "a watcher never sees anyone's hidden cards");
  const counted = await new Promise((resolve) => {
    const ws = new WebSocket(`${WSB}/ws/lobby?token=${a.token}`);
    ws.onmessage = (e) => { if (e.data === "pong") return; const t = JSON.parse(e.data).tables.find((x) => x.id === a.tableId); ws.close(); resolve(t?.watchers); };
    setTimeout(() => resolve(null), 5000);
  });
  check(counted === 1, `the lobby shows 1 watching (${counted})`);

  // 3. Take a seat from watching
  await v.click('[data-testid="watch-join"]');
  await v.waitForFunction(() => window.__poker.state?.you.seat >= 0 || window.__poker.state?.you.waiting, null, { timeout: 15000 }).catch(() => {});
  const joined = await v.evaluate(() => ({ seat: window.__poker.state?.you.seat, waiting: window.__poker.state?.you.waiting, table: window.__poker.tableId, watching: window.__poker.watching }));
  check(joined.table === a.tableId && !joined.watching && (joined.seat >= 0 || joined.waiting), "Take a seat from watching joins that table");
  await v.click('[data-testid="leave"]').catch(() => {});

  await wait(60000); // sign-up rate limit
  // 4. Private tables: unlisted, never used by quick seat, joinable by link
  const p = await bot("Pia", { private: true });
  check(/^p-[0-9a-f]{16}$/.test(p.tableId), `a private table gets a long, unguessable id (${p.tableId})`);
  await wait(2500);
  const listed = await new Promise((resolve) => {
    const ws = new WebSocket(`${WSB}/ws/lobby?token=${p.token}`);
    ws.onmessage = (e) => { if (e.data === "pong") return; ws.close(); resolve(JSON.parse(e.data).tables.map((t) => t.id)); };
    setTimeout(() => resolve(null), 5000);
  });
  check(listed && !listed.includes(p.tableId), "the private table isn't in the public list");
  const q = await bot("Quin");
  check(q.tableId !== p.tableId, "quick seat never puts a stranger in a private table");
  const w = await newPage();
  await w.goto(`${base}/?table=${p.tableId}`, { waitUntil: "domcontentloaded" });
  await w.fill('[data-testid="name"]', "Wyn");
  await w.click('[data-testid="login"]');
  await w.waitForFunction(() => window.__poker.state?.you, null, { timeout: 15000 }).catch(() => {});
  const viaLink = await w.evaluate(() => ({ table: window.__poker.tableId, invite: !document.getElementById("invite-btn").hidden }));
  check(viaLink.table === p.tableId, "opening the invite link signs in and goes straight to the private table");
  check(viaLink.invite, "the Invite button is offered at a private table");

  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join("; ") : ""}`);
  for (const x of [a, p, q]) { x.ws.send(JSON.stringify({ type: "leave" })); }
  await w.click('[data-testid="leave"]').catch(() => {});
  await wait(500);
  for (const x of [a, p, q]) x.ws.close();
  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL LOBBY CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
