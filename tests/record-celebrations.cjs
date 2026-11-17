// Records every win celebration in turn: node tests/record-celebrations.cjs [baseUrl]
const { chromium } = require("playwright");
const fs = require("fs");
const base = process.argv[2] || "http://localhost:8787";
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: "tests/out/video", size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?demo=celebrate&room=penthouse&deck=ivory&chips=goldfoil`);
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(Math.max(0, 600 + i * 4200 + 1100 - (Date.now() - t0)));
    await page.screenshot({ path: `tests/out/celebration-${i + 1}.png` });
  }
  await page.waitForTimeout(3500);
  const v = page.video();
  await ctx.close();
  fs.renameSync(await v.path(), "tests/out/celebrations.webm");
  await browser.close();
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
})();
