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
  // Close-up of the card designs
  const gallery = await browser.newPage({ viewport: { width: 1100, height: 430 }, deviceScaleFactor: 2 });
  await gallery.goto(`${base}/?demo=turn`);
  await gallery.waitForTimeout(600);
  await gallery.evaluate(() => {
    document.body.innerHTML += "";
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:99;display:flex;gap:26px;align-items:center;justify-content:center;flex-wrap:wrap;padding:30px;background:radial-gradient(ellipse at center,#1e7a4f 0%,#0b3a25 80%)";
    for (const c of ["As", "Kh", "Qd", "Jc", "Th", "7s", "??"]) {
      const el = window.__poker.cardEl(c);
      el.style.setProperty("--w", "120px");
      wrap.append(el);
    }
    document.body.append(wrap);
  });
  await gallery.waitForTimeout(500);
  await gallery.screenshot({ path: "tests/out/cards-closeup.png" });
  await gallery.close();

  const phone = await browser.newPage({ ...devices["iPhone 13"] });
  await phone.goto(`${base}/?demo=turn`);
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: "tests/out/demo-phone.png", fullPage: true });
  await browser.close();
})();
