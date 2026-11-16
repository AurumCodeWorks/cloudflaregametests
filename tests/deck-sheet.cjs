// Renders all deck themes side by side: node tests/deck-sheet.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
const DECKS = [
  ["ivory", "Ivory & Gold", "Linen stock, gold foil frame, serif"],
  ["noir", "Noir", "Matte black, gold and red foil"],
  ["deco", "Art Deco", "1920s cream, black and gold geometry"],
  ["casino", "Casino Pro", "Crisp white, jumbo indices, easy to read"],
  ["royal", "Royal Four-Colour", "Gilded edges, every suit its own colour"],
  ["modern", "Modern", "Minimal, big number and big suit"],
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 790 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/?demo=turn`);
  await page.waitForTimeout(800);
  await page.evaluate((DECKS) => {
    const sheet = document.createElement("div");
    sheet.style.cssText = "position:fixed;inset:0;z-index:99;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:min-content;align-content:center;gap:18px;padding:22px;background:#0b0f14;font-family:Inter,sans-serif";
    DECKS.forEach(([id, name, sub], i) => {
      const tile = document.createElement("div");
      tile.dataset.deck = id;
      tile.style.cssText = "border-radius:16px;padding:16px 18px 20px;background:radial-gradient(ellipse at center,#1e7a4f 0%,#0c3d27 85%);border:1px solid #2d3644";
      tile.innerHTML = `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px"><span style="background:#f2c14e;color:#111;font-weight:800;border-radius:999px;width:24px;height:24px;display:inline-grid;place-items:center;font-size:13px">${i + 1}</span><span style="color:#fff;font-weight:700;font-size:18px">${name}</span><span style="color:#cfe0d6;font-size:13px">${sub}</span></div>`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;justify-content:center";
      for (const c of ["As", "Kh", "Qd", "Jc", "Th", "??"]) {
        const el = window.__poker.cardEl(c);
        el.style.setProperty("--w", "92px");
        row.append(el);
      }
      tile.append(row);
      sheet.append(tile);
    });
    document.body.append(sheet);
  }, DECKS);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "tests/out/deck-selection.png" });
  await browser.close();
})();
