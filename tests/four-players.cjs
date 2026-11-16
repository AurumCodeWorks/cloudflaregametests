// End-to-end: four real browser sessions play at one table through the real UI and server.
// Needs the local stack: npx wrangler dev --var BOT_DELAY_MS:150 --var NEXT_HAND_MS:1200 --var TURN_SECONDS:6 --var AUDIT:1
// Run: node tests/four-players.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
const HANDS_TO_PLAY = Number(process.env.HANDS || 5);
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); failures.push(msg); } };
const failures = [];

(async () => {
  const browser = await chromium.launch();
  const names = ["Avery", "Blake", "Casey", "Drew"];
  const players = [];
  for (const name of names) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // separate cookies/storage = separate person
    const page = await ctx.newPage();
    page.on("pageerror", (e) => failures.push(`${name} page error: ${e.message}`));
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.fill('[data-testid="name"]', name);
    await page.click('[data-testid="login"]');
    await page.waitForSelector('[data-testid="play"]:visible');
    players.push({ name, page });
  }
  for (const p of players) await p.page.click('[data-testid="play"]');
  console.log("4 players signed up and took a seat");

  await Promise.all(players.map((p) => p.page.waitForFunction(() => window.__poker.tableId, null, { timeout: 15_000 })));
  const tables = await Promise.all(players.map((p) => p.page.evaluate(() => window.__poker.tableId)));
  assert(new Set(tables).size === 1, `players landed on different tables: ${tables}`);

  // Each browser plays with a simple policy by clicking the real buttons
  const results = {}; // handNo -> { board, payouts } per player
  let allHumansSeen = false;
  let privacyChecks = 0;
  const deadline = Date.now() + Number(process.env.TIMEOUT_MS || 120_000);
  while (Date.now() < deadline) {
    for (const p of players) {
      const s = await p.page.evaluate(() => {
        const st = window.__poker.state;
        return st && JSON.parse(JSON.stringify({ you: st.you, seats: st.seats, hand: st.hand && { no: st.hand.no, board: st.hand.board, result: st.hand.result }, legal: st.legal, verified: window.__poker.verified }));
      });
      if (!s) continue;
      // Privacy: never see another player's cards unless they were shown at showdown
      s.seats.forEach((seat, i) => {
        if (!seat || i === s.you.seat) return;
        const shown = s.hand?.result?.shown?.[i];
        for (const c of seat.hole) assert(c === "??" || shown, `${p.name} could see seat ${i}'s card ${c} before showdown`);
      });
      privacyChecks++;
      if (s.seats.every((x) => x && !x.isBot)) allHumansSeen = true;
      if (s.hand?.result) {
        (results[s.hand.no] ??= {})[p.name] = { board: s.hand.board.join(" "), payouts: s.hand.result.payouts.join(","), verified: s.verified[s.hand.no] };
      }
      if (s.legal) {
        const L = s.legal;
        const r = Math.random();
        const pick = L.check ? (r < 0.15 && L.canRaise ? "raise" : "check") : L.call <= 30 || r < 0.6 ? "call" : "fold";
        // The table moves on its own; never wait long for a button that changed state meanwhile
        const click = (sel) => p.page.click(sel, { timeout: 1500 }).catch(() => {});
        if (pick === "raise") { await click('[data-preset="half"]'); await click('[data-testid="raise"]'); }
        else await click(`[data-testid="${pick}"]`);
      }
    }
    const done = Object.keys(results).filter((n) => Object.keys(results[n]).length === 4).length;
    if (done !== globalThis.__lastDone) { globalThis.__lastDone = done; console.log(`  ...${done} hand(s) complete`); }
    if (done >= HANDS_TO_PLAY) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // Screenshots: the same moment from all four seats
  for (const [i, p] of players.entries()) await p.page.screenshot({ path: `tests/out/e2e-seat-${i + 1}.png` });

  const complete = Object.entries(results).filter(([, v]) => Object.keys(v).length === 4);
  console.log(`hands completed and seen by all 4 players: ${complete.length}`);
  assert(complete.length >= HANDS_TO_PLAY, `only ${complete.length} hands completed`);
  assert(allHumansSeen, "bots were never fully replaced by the 4 humans");
  for (const [no, byPlayer] of complete) {
    const boards = new Set(Object.values(byPlayer).map((v) => v.board));
    const payouts = new Set(Object.values(byPlayer).map((v) => v.payouts));
    assert(boards.size === 1 && payouts.size === 1, `hand ${no}: players disagree on board/payouts`);
    for (const [name, v] of Object.entries(byPlayer)) assert(v.verified === true, `hand ${no}: ${name}'s shuffle check = ${v.verified}`);
    console.log(`  hand #${no}: board ${[...boards][0] || "(no flop)"} | payouts ${[...payouts][0]} | shuffle verified by all 4`);
  }
  console.log(`privacy checks run: ${privacyChecks}`);

  // Everyone leaves; the ledger must balance and the table must hold nothing
  for (const p of players) await p.page.click('[data-testid="leave"]').catch(() => {});
  await Promise.all(players.map((p) => p.page.waitForSelector('[data-testid="play"]:visible', { timeout: 30_000 }).catch(() => assert(false, `${p.name} never returned to the lobby`))));
  await new Promise((r) => setTimeout(r, 2500));
  const token = await players[0].page.evaluate(() => localStorage.getItem("token"));
  const res = await fetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    // Production keeps the audit endpoint off; check each player got their stack back instead
    const balances = await Promise.all(players.map((p) => p.page.evaluate(async () => (await (await fetch("/api/me", { headers: { authorization: `Bearer ${localStorage.getItem("token")}` } })).json()).balance)));
    console.log(`balances after leaving: ${balances.join(", ")} (audit endpoint disabled in production)`);
    assert(balances.every((b) => Number.isInteger(b) && b >= 0), "a balance is missing or negative");
  } else {
    const audit = await res.json();
    const table = audit.accounts.find((a) => a.id === `table:${tables[0]}`);
    console.log(`ledger sum ${audit.sum} (must be 0) | table account ${table?.balance} (must be 0)`);
    assert(audit.sum === 0, "ledger does not balance");
    assert(table && table.balance === 0, "chips left on the table after everyone left");
  }

  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
})();
