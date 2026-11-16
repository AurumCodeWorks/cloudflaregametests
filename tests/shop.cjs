// Cosmetics shop: server rules + two browsers checking that others see your equipped deck.
// Needs the local stack (see README). Run: node tests/shop.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const call = async (path, token, body) => {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return [r.status, await r.json()];
};

(async () => {
  // ---------------------------------------------------------------- server rules
  const login = await (await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Shopper" }) })).json();
  const T = login.token;
  let [st, shop] = await call("/api/shop", T);
  check(st === 200 && shop.catalog.length >= 30, `catalogue loads (${shop.catalog.length} items, mode "${shop.mode}")`);
  check(["deck:modern", "room:classic", "chips:casino", "celebration:glow"].every((i) => shop.owned.includes(i)), "free items are owned by everyone");
  check(shop.equipped.deck === "deck:modern", "new players start with the free deck equipped");
  check((await call("/api/shop/equip", T, { itemId: "deck:noir" }))[0] === 403, "can't equip a deck you don't own");
  check((await call("/api/shop/buy", T, { itemId: "deck:modern" }))[0] === 400, "free items can't be 'bought'");
  check((await call("/api/shop/buy", T, { itemId: "deck:made-up" }))[0] === 404, "unknown items are rejected");
  [st, shop] = await call("/api/shop/buy", T, { itemId: "deck:noir" });
  check(st === 200 && shop.owned.includes("deck:noir"), "buying Noir grants it");
  check((await call("/api/shop/buy", T, { itemId: "deck:noir" }))[0] === 409, "can't buy the same item twice");
  [st, shop] = await call("/api/shop/buy", T, { itemId: "bundle:penthouse" });
  check(st === 200 && ["room:penthouse", "deck:ivory"].every((i) => shop.owned.includes(i)), "a collection grants all of its items");
  check((await call("/api/shop/buy", T, { itemId: "bundle:penthouse" }))[0] === 409, "can't re-buy a collection you fully own");
  [st, shop] = await call("/api/shop/equip", T, { itemId: "room:penthouse" });
  check(st === 200 && shop.equipped.room === "room:penthouse", "equipping a room you own works");
  check((await call("/api/shop/equip", T, { itemId: "bundle:penthouse" }))[0] === 400, "collections themselves can't be equipped");

  // ---------------------------------------------------------------- two browsers
  const browser = await chromium.launch();
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => check(false, `${name} page error: ${e.message}`));
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.fill('[data-testid="name"]', name);
    await page.click('[data-testid="login"]');
    await page.waitForSelector('[data-testid="play"]:visible');
    return page;
  };
  const a = await mk("Harper");
  // Harper buys Noir through the real shop UI, then a celebration
  await a.click('[data-testid="lobby-shop"]');
  await a.waitForSelector('[data-item="deck:noir"] [data-action="buy"]');
  await a.screenshot({ path: "tests/out/shop-decks.png" });
  await a.click('[data-item="deck:noir"] [data-action="buy"]');
  await a.waitForSelector('[data-item="deck:noir"].equipped', { timeout: 10_000 });
  check(true, "Harper bought and equipped Noir in the shop");
  await a.click('.shop-tabs [data-tab="celebration"]');
  await a.click('[data-item="celebration:goldrush"] [data-action="buy"]');
  await a.waitForSelector('[data-item="celebration:goldrush"].equipped', { timeout: 10_000 });
  await a.click('.shop-tabs [data-tab="room"]');
  await a.waitForTimeout(400);
  await a.screenshot({ path: "tests/out/shop-rooms.png" });
  await a.click('.shop-tabs [data-tab="bundle"]');
  await a.waitForTimeout(400);
  await a.screenshot({ path: "tests/out/shop-collections.png" });
  await a.click("#shop-close");
  check(await a.evaluate(() => document.documentElement.dataset.deck) === "noir", "Harper's own view switched to Noir");

  const b = await mk("Quinn");
  await a.click('[data-testid="play"]');
  await a.waitForFunction(() => window.__poker.tableId);
  await b.click('[data-testid="play"]');
  await b.waitForFunction(() => window.__poker.tableId);
  check(await a.evaluate(() => window.__poker.tableId) === await b.evaluate(() => window.__poker.tableId), "both players are at the same table");

  // Wait until both are dealt into the same hand, then look at Harper's cards from Quinn's seat
  const seen = await b.waitForFunction(() => {
    const s = window.__poker.state;
    if (!s?.hand || s.hand.result || s.you.seat < 0) return null;
    const harper = s.seats.findIndex((x) => x && x.name === "Harper");
    if (harper < 0 || !s.seats[harper].inHand) return null;
    const el = document.querySelector(`.seat[data-abs="${harper}"] .hole .card`);
    const mine = document.querySelector(`.seat[data-abs="${s.you.seat}"] .hole .card`);
    return el && mine ? { harperDeck: el.dataset.deck, harperBack: el.classList.contains("back"), myDeck: mine.dataset.deck, cosmetics: s.seats[harper].cosmetics } : null;
  }, null, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => null);
  check(seen && seen.harperBack && seen.harperDeck === "noir", `Quinn sees Harper's card backs in Noir (${JSON.stringify(seen)})`);
  check(seen && seen.myDeck === "modern", "Quinn's own cards stay in Quinn's free deck");
  check(seen && seen.cosmetics.celebration === "goldrush", "the table knows Harper's win celebration");
  await b.waitForTimeout(1500);
  await b.screenshot({ path: "tests/out/shop-seen-by-quinn.png" });

  // Phone layout of the shop
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await phone.goto(base + "/", { waitUntil: "domcontentloaded" });
  await phone.evaluate((t) => localStorage.setItem("token", t), T);
  await phone.reload({ waitUntil: "domcontentloaded" });
  await phone.waitForSelector('[data-testid="lobby-shop"]:visible');
  await phone.click('[data-testid="lobby-shop"]');
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: "tests/out/shop-phone.png" });
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= 390), "shop fits a phone screen without sideways scrolling");

  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL SHOP CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
