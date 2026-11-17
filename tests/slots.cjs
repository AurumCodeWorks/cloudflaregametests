// Slot machines in a real browser. Needs the dev server. Run: node tests/slots.cjs [baseUrl]
// The lobby picker, a spin on each machine, the responsible-design rules (no autoplay, 2.5 s per spin,
// no way to cut a spin short, no win sound for a return of the stake or less, time and net on screen,
// Stop), and the provably-fair check running in the page.
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errs.push(e.message));
  pg.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  await pg.goto(base);
  await pg.fill("#name", "Reels" + (Date.now() % 1000));
  await pg.click('[data-testid="login"]');
  await pg.waitForSelector("#screen-lobby:not([hidden])");

  // ---- lobby: poker and both machines side by side, RTP on the card
  const cards = await pg.$$eval('[data-testid="games"] .game-card', (els) => els.map((e) => ({ game: e.dataset.game, text: e.textContent.replace(/\s+/g, " "), visible: e.getBoundingClientRect().height > 0 })));
  check(cards.map((c) => c.game).join() === "poker,sevens,royal" && cards.every((c) => c.visible), "the lobby offers Hold'em, Lucky Sevens and Royal Reels");
  check(/returns 95\.21%/.test(cards[1].text) && /returns 94\.98%/.test(cards[2].text) && /10p to £5 of play money/.test(cards[1].text), "each slot card states its stakes (play money) and its return to player");
  check(await pg.isVisible('[data-testid="play"]'), "poker's Take a seat is still there");

  for (const id of ["sevens", "royal"]) {
    await pg.click(`[data-testid="play-${id}"]`);
    await pg.waitForSelector('[data-testid="spin"]:not([disabled])');
    const reels = id === "sevens" ? 3 : 5;
    check((await pg.$$("#reel-window .reel")).length === reels, `${id}: ${reels} reels`);
    const stakeKeys = await pg.$$eval("#stakes [data-stake]", (b) => b.map((x) => x.textContent));
    check(stakeKeys.join() === "10p,20p,50p,£1,£2,£5", `${id}: stake keys are 10p, 20p, 50p, £1, £2, £5 and nothing higher`);
    check(/play money/i.test(await pg.textContent("#stakes")) && /play money/i.test(await pg.textContent(".slot-title")), `${id}: clearly labelled as play money`);
    const page = (await pg.textContent("#screen-slots")).toLowerCase();
    check(!(await pg.$('#screen-slots [data-testid*="auto"], #screen-slots [id*="auto"], #screen-slots [id*="turbo"], #screen-slots [id*="quick"]')) && !/auto ?spin|autoplay on|turbo mode|quick spin on/.test(page.replace(/no autoplay|no turbo/g, "")), `${id}: there is no autoplay, turbo or quick-spin control`);
    check((await pg.isVisible('[data-testid="sess-time"]')) && (await pg.isVisible('[data-testid="sess-net"]')) && (await pg.isVisible('[data-testid="slot-stop"]')), `${id}: time played, net result and Stop are on screen`);

    // ---- one press, one spin, at least 2.5 s; pressing again mid-spin does nothing
    await pg.click('[data-testid="stake-20"]');
    const nonce0 = await pg.evaluate(() => window.__slots.state.nonce);
    const t0 = Date.now();
    await pg.click('[data-testid="spin"]');
    await pg.waitForTimeout(150);
    check(await pg.isDisabled('[data-testid="spin"]'), `${id}: the Spin key is off while the reels turn`);
    await pg.evaluate(() => { const b = document.getElementById("spin-btn"); b.disabled = false; b.click(); b.click(); b.disabled = true; }); // a forced extra press
    await pg.keyboard.press("Space"); await pg.keyboard.press("Enter");
    await pg.click("#reel-window", { force: true }); // clicking the reels (a "slam stop") does nothing
    await pg.waitForTimeout(900);
    check(await pg.evaluate(() => window.__slots.spinning) && (await pg.$$eval("#reel-window .tape", (t) => t.some((x) => x.getAnimations().length > 0))), `${id}: still spinning after extra presses, key presses and clicking the reels`);
    await pg.waitForSelector('[data-testid="spin"]:not([disabled])');
    const took = Date.now() - t0;
    check(took >= 2500, `${id}: the spin took ${took} ms (at least 2500)`);
    const st = await pg.evaluate(() => ({ nonce: window.__slots.state.nonce, sess: window.__slots.state.session, stops: window.__slots.stops[window.__slots.machine], tier: window.__slots.lastTier }));
    check(st.nonce === nonce0 + 1, `${id}: exactly one spin was made (no second spin from the extra presses)`);
    await pg.waitForTimeout(1200);
    check((await pg.evaluate(() => window.__slots.state.nonce)) === nonce0 + 1 && !(await pg.evaluate(() => window.__slots.spinning)), `${id}: nothing spins by itself afterwards`);
    const result = await pg.textContent('[data-testid="slot-result"]');
    check(/No win|returned|you win/.test(result), `${id}: the result is stated in words ("${result}")`);
    const net = await pg.textContent('[data-testid="sess-net"]');
    const expect = st.sess.returned - st.sess.staked;
    check((expect === 0 && net === "0p") || (expect < 0 && net.startsWith("−")) || (expect > 0 && net.startsWith("+")), `${id}: net this session shows ${net}`);

    // ---- the reels rest exactly on the server's stops (middle row), drawn from the published strip
    const shown = await pg.evaluate(() => {
      const win = document.getElementById("reel-window").getBoundingClientRect(), mid = win.top + win.height / 2;
      return [...document.querySelectorAll("#reel-window .reel")].map((r) => { const c = [...r.querySelectorAll(".cell")].find((c) => { const b = c.getBoundingClientRect(); return b.top < mid && b.bottom > mid; }); return +c.dataset.stop; });
    });
    check(JSON.stringify(shown) === JSON.stringify(st.stops), `${id}: the middle row shows the stops the server sent`);

    // ---- several spins: a return of the stake or less never gets a win sound or celebration
    const tiers = [st.tier];
    for (let k = 0; k < 7; k++) {
      await pg.click('[data-testid="spin"]');
      await pg.waitForFunction(() => !window.__slots.spinning, null, { timeout: 15000 });
      const r = await pg.evaluate(() => ({ tier: window.__slots.lastTier, kind: document.getElementById("slot-result").dataset.kind, win: document.getElementById("cabinet").classList.contains("has-win"), fx: !!document.querySelector(".float-win, .fx-headline, .fx-rays"), played: (window.__sound?.played ?? []).slice(-6) }));
      tiers.push(r.tier);
      if (r.tier === "none") check(r.kind !== "win" && !r.win && !r.fx && !r.played.some((n) => /win|celebrate/.test(n)), `${id}: spin ${k + 2} returned the stake or less: shown plainly (${r.kind}), no highlight, no celebration, no win sound`);
      else check(r.kind === "win" && r.win, `${id}: spin ${k + 2} was a real win (${r.tier}) and is shown as one`);
      await pg.waitForSelector('[data-testid="spin"]:not([disabled])');
    }

    // ---- paytable, exact RTP and the reel strips are published in the page
    await pg.click('[data-testid="slot-info"]');
    await pg.waitForTimeout(600);
    check(new RegExp(id === "sevens" ? "95\\.21%" : "94\\.98%").test(await pg.textContent('[data-testid="rtp"]')), `${id}: the info panel shows the exact return to player`);
    check((await pg.$$('[data-testid="paytable"] .pt-row')).length === (id === "sevens" ? 12 : 9) && (await pg.$$('[data-testid="strips"] .strip')).length === reels, `${id}: full paytable and every reel strip are shown`);

    // ---- provably fair: reveal the server seed and re-play every spin in the browser
    await pg.click('[data-testid="tab-fair"]');
    const commitBefore = await pg.evaluate(() => window.__slots.state.commit);
    const seedNo = await pg.evaluate(() => window.__slots.state.seedNo);
    await pg.fill('[data-testid="fair-seed"]', `my-own-seed-${id}`);
    await pg.click('[data-testid="fair-rotate"]');
    await pg.waitForFunction((n) => window.__slots.verified[n], seedNo, { timeout: 15000 });
    const v = await pg.evaluate((n) => window.__slots.verified[n], seedNo);
    check(v.ok && v.spins === 8 && v.commit === commitBefore, `${id}: all ${v.spins} spins re-played and verified in the browser against the fingerprint shown before them`);
    check(/✔ 8 spins re-played/.test(await pg.textContent('[data-testid="fair-result"]')) && /Verified 8 spins/.test(await pg.textContent('[data-testid="slot-fair"]')), `${id}: the page says so`);
    check((await pg.evaluate(() => window.__slots.state.clientSeed)) === `my-own-seed-${id}` && (await pg.evaluate(() => window.__slots.state.nonce)) === 0, `${id}: the player's own typed seed is now in use, counter back to 0`);
    // a doctored history must fail the same check
    const tampered = await pg.evaluate(async (n) => {
      const real = window.fetch;
      window.fetch = async (u, o) => { const r = await real(u, o); if (!String(u).includes("/api/slots/history")) return r; const j = await r.json(); j.spins[0].stops[0] = (j.spins[0].stops[0] + 1) % 10; return new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } }); };
      const seeds = await (await real("/api/slots/seeds", { headers: { authorization: `Bearer ${localStorage.getItem("token")}` } })).json();
      const seed = seeds.seeds.find((s) => s.seedNo === n);
      const res = { ...(await window.__poker.slots.verifySeed(seed)) };
      window.fetch = real;
      await window.__poker.slots.verifySeed(seed); // put the honest result back
      return res;
    }, seedNo);
    check(tampered.ok === false, `${id}: a tampered spin fails the browser's check ("${tampered.problem}")`);
    await pg.click("#slot-drawer-close");
    await pg.waitForTimeout(600);

    // ---- Stop: a summary, then back to the games
    await pg.click('[data-testid="slot-stop"]');
    await pg.waitForSelector('[data-testid="slot-summary"]');
    const sum = await pg.textContent('[data-testid="slot-summary"]');
    check(/Time played/.test(sum) && /Net result/.test(sum) && /Spins\s*8/.test(sum.replace(/\s+/g, " ")), `${id}: Stop shows the session's time, spins and net result`);
    await pg.click('[data-testid="sum-done"]');
    await pg.waitForSelector("#screen-lobby:not([hidden])");
    check(true, `${id}: back in the lobby`);
  }

  // ---- phone: nothing spills off the screen
  const ph = await (await browser.newContext({ viewport: { width: 390, height: 780 }, storageState: await ctx.storageState() })).newPage();
  ph.on("pageerror", (e) => errs.push(e.message));
  for (const id of ["sevens", "royal"]) {
    await ph.goto(`${base}/?game=${id}`);
    await ph.waitForSelector('[data-testid="spin"]:not([disabled])');
    const fit = await ph.evaluate(() => ({ scroll: document.documentElement.scrollWidth, w: innerWidth, win: document.getElementById("reel-window").getBoundingClientRect() }));
    check(fit.scroll <= fit.w && fit.win.left >= 0 && fit.win.right <= fit.w, `${id}: fits a phone screen without sideways scrolling`);
  }

  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join(" | ") : ""}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall slot browser checks passed");
  process.exit(failures ? 1 : 0);
})();
