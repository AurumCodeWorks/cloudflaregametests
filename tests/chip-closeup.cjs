// One large chip from each set: node tests/chip-closeup.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
const PICKS = [["casino", 25, "Casino Clay"], ["tricolour", 5, "Tri-Colour Clay"], ["ceramic", 100, "Ceramic Pro"], ["highroller", 500, "High Roller"], ["pearl", 25, "Mother of Pearl"], ["goldfoil", 1000, "Gold Foil"]];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 420 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/?demo=turn`);
  await page.waitForTimeout(700);
  await page.evaluate((PICKS) => {
    const FX = window.__poker.FX;
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:99;display:flex;gap:26px;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#1e7a4f 0%,#0b3a25 85%);font-family:Inter";
    for (const [id, d, name] of PICKS) {
      FX.setChipStyle(id);
      const col = document.createElement("div");
      col.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:14px;color:#fff;font-weight:700;font-size:15px";
      col.append(FX.chipStack(0, 210, [d, d]), Object.assign(document.createElement("div"), { textContent: name }));
      wrap.append(col);
    }
    document.body.append(wrap);
  }, PICKS);
  await page.waitForTimeout(700);
  await page.screenshot({ path: "tests/out/chip-closeup.png" });
  await browser.close();
})();
