// Disconnection recovery in a real browser: the connection drops mid-hand, the page shows a banner, reconnects
// by itself into the same seat; a reload goes straight back to the table. Needs the dev server.
// Run: node tests/reconnect.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.fill('[data-testid="name"]', "Rejoiner");
  await page.click('[data-testid="login"]');
  await page.click('[data-testid="play"]');
  await page.waitForFunction(() => window.__poker.state?.hand && !window.__poker.state.hand.result && window.__poker.state.you.seat >= 0, null, { timeout: 30000 });
  const seat = await page.evaluate(() => window.__poker.state.you.seat);
  const table = await page.evaluate(() => window.__poker.tableId);

  // 1. The connection drops mid-hand
  await page.evaluate(() => window.__poker.ws.close());
  await page.waitForSelector('[data-testid="conn-banner"]:visible', { timeout: 3000 }).catch(() => {});
  const bannerText = await page.textContent("#conn-text").catch(() => "");
  check(/Reconnecting/.test(bannerText) && /held/.test(bannerText), `a banner explains it and says the seat is held ("${bannerText.trim()}")`);
  await page.waitForSelector('[data-testid="conn-banner"]', { state: "hidden", timeout: 15000 }).catch(() => {});
  check(await page.isHidden('[data-testid="conn-banner"]'), "reconnected by itself and the banner went away");
  const after = await page.evaluate(() => ({ seat: window.__poker.state.you.seat, table: window.__poker.tableId, screen: !document.getElementById("screen-table").hidden }));
  check(after.table === table && after.seat === seat && after.screen, `still at the same table and seat (${after.seat})`);

  // 2. A reload (or opening the site again) goes straight back to the seat
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__poker.state?.you, null, { timeout: 15000 }).catch(() => {});
  const reloaded = await page.evaluate(() => ({ seat: window.__poker.state?.you.seat, table: window.__poker.tableId, screen: !document.getElementById("screen-table").hidden }));
  check(reloaded.screen && reloaded.table === table && reloaded.seat === seat, `after a reload, back at the table in seat ${reloaded.seat} without clicking anything`);

  // 3. Leaving on purpose really leaves (no reconnect, nothing held)
  await page.click('[data-testid="leave"]');
  await page.waitForSelector('[data-testid="play"]:visible', { timeout: 15000 }).catch(() => {});
  check(await page.isVisible('[data-testid="play"]'), "Leave goes back to the lobby");
  await page.waitForTimeout(1500);
  check(await page.isHidden('[data-testid="conn-banner"]'), "no reconnect attempt after leaving on purpose");
  const me = await page.evaluate(async () => (await fetch("/api/me", { headers: { authorization: `Bearer ${localStorage.getItem("token")}` } })).json());
  check(me.table === null, "and the server no longer holds a seat for them");
  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join("; ") : ""}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL BROWSER RECONNECT CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
