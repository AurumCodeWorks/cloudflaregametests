// Sound: effects fire with the game, music follows the room, the panel switches both. Needs the dev server
// with the audio uploaded locally (node tools/upload-audio.mjs --local). Run: node tests/sound.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=user-gesture-required"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  const errs = [], missing = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("response", (r) => { if (r.url().includes("/audio/") && r.status() >= 400) missing.push(`${r.status()} ${r.url()}`); });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  check(await page.evaluate(() => window.__sound.state()) === "none", "no audio engine before the player interacts");
  await page.fill('[data-testid="name"]', "Listener");
  await page.click('[data-testid="login"]');
  await page.waitForSelector('[data-testid="play"]:visible');
  check(await page.evaluate(() => window.__sound.state()) === "running", "the first click starts the audio engine");

  // Panel defaults: effects on, music off
  await page.click('[data-testid="sound"]');
  check(await page.isChecked('[data-testid="snd-effects"]') && !(await page.isChecked('[data-testid="snd-music"]')), "effects start on, music starts off");
  await page.click('[data-testid="sound"]');

  // Play: call/check until two hands have finished, then look at what was heard
  await page.click('[data-testid="play"]');
  const end = Date.now() + 90_000;
  let hands = new Set();
  while (Date.now() < end && hands.size < 2) {
    for (const sel of ['[data-testid="check"]:visible:enabled', '[data-testid="call"]:visible:enabled']) await page.click(sel, { timeout: 300 }).catch(() => {});
    const no = await page.evaluate(() => window.__poker.state?.hand?.result ? window.__poker.state.hand.no : null);
    if (no) hands.add(no);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(3500); // the next hand's shuffle and deal
  const played = await page.evaluate(() => window.__sound.played.slice());
  const count = (n) => played.filter((p) => p === n).length;
  console.log("  heard:", Object.entries(played.reduce((a, p) => ((a[p] = (a[p] ?? 0) + 1), a), {})).map(([k, v]) => `${k}×${v}`).join(", "));
  check(count("card-deal") >= 8, "a card-deal sound for every hole card dealt");
  check(count("chip-bet") + count("all-in") >= 1, "bets make a chip sound");
  check(count("chip-stack") >= 1, "bets swept into the pot make a stacking sound");
  check(count("card-flip") >= 3, "board cards make a flip sound");
  check(count("pot-win") >= 1, "the pot going to the winner makes a sound");
  check(count("your-turn") >= 1, "your turn chimes");
  check(count("ui-click") >= 1, "buttons click");
  check(count("shuffle") >= 1, "the deck is shuffled before the next deal");
  check(played.some((p) => p.startsWith("celebrate-")), "a win plays its celebration sound");
  check(count("card-deal") < 40 && count("chip-bet") < 30, "one chip sound per bet, not one per chip");

  // Music: on, follows the room, off
  await page.click('[data-testid="sound"]');
  await page.click('[data-testid="snd-music"]');
  await page.waitForFunction(() => window.__sound.musicTime() > 0.5, null, { timeout: 15_000 }).catch(() => {});
  check(await page.evaluate(() => window.__sound.track) === "music-lounge" && (await page.evaluate(() => window.__sound.musicTime())) > 0.5, "music on: the Classic room plays the lounge track");
  check((await page.textContent("#snd-now")).includes("Lounge piano and bass"), "the panel names the track");
  await page.evaluate(() => window.__poker.setRoom("speakeasy"));
  await page.waitForTimeout(500);
  check(await page.evaluate(() => window.__sound.track) === "music-speakeasy", "changing room crossfades to that room's track");
  await page.evaluate(() => window.__poker.setRoom("classic"));
  await page.click('[data-testid="snd-music"]');
  await page.waitForTimeout(900);
  check(await page.evaluate(() => window.__sound.track) === null && (await page.evaluate(() => window.__sound.musicTime())) === 0, "music off stops it");
  const n = await page.evaluate(() => window.__sound.played.length);
  await page.click('[data-testid="snd-effects"]');
  await page.click('[data-testid="sound"]');
  await page.waitForTimeout(3000);
  check(await page.evaluate((n) => window.__sound.played.length === n, n), "effects off: nothing more plays");
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("sound")).effects === false), "settings are remembered on this device");

  check(missing.length === 0, `every audio file loaded${missing.length ? ": " + missing.join(", ") : ""}`);
  check(errs.length === 0, `no page errors${errs.length ? ": " + errs.join("; ") : ""}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nALL SOUND CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
