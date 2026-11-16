// Renders the UI preview states to PNGs: node tests/screenshot-demo.cjs [baseUrl]
const { chromium, devices } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
(async () => {
  const browser = await chromium.launch();
  for (const demo of ["turn", "showdown"]) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/?demo=${demo}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `tests/out/demo-${demo}.png` });
    console.log(demo, "verified:", await page.evaluate(() => JSON.stringify(window.__poker.verified)), errors.join("; ") || "no errors");
    await page.close();
  }
  const phone = await browser.newPage({ ...devices["iPhone 13"] });
  await phone.goto(`${base}/?demo=turn`);
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: "tests/out/demo-phone.png", fullPage: true });
  await browser.close();
})();
