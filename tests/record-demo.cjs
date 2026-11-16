// Records the scripted hand with animations: node tests/record-demo.cjs [baseUrl] [query] [name]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
const query = process.argv[3] || "room=penthouse&deck=ivory&chips=goldfoil&celebration=goldrush";
const name = process.argv[4] || "demo-hand";
const fs = require("fs");
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: "tests/out/video", size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?demo=play&${query}`);
  const stills = { 900: "deal", 2400: "raise-chips", 7250: "flop-flip", 20300: "showdown-win", 21600: "celebration" };
  const t0 = Date.now();
  for (const [at, label] of Object.entries(stills)) {
    await page.waitForTimeout(Math.max(0, +at - (Date.now() - t0)));
    await page.screenshot({ path: `tests/out/${name}-${label}.png` });
  }
  await page.waitForTimeout(3500);
  const video = page.video();
  await ctx.close();
  fs.renameSync(await video.path(), `tests/out/${name}.webm`);
  await browser.close();
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
})();
