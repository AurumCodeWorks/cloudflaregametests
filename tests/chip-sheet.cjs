// Renders all chip sets side by side: node tests/chip-sheet.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
const SETS = [
  ["casino", "Casino Clay", "Tier 1 · Free · six inserts, suited mold, ivory inlay"],
  ["tricolour", "Tri-Colour Clay", "Tier 2 · three-colour inserts, coloured inlay ring"],
  ["ceramic", "Ceramic Pro", "Tier 3 · edge-to-edge print, gloss"],
  ["highroller", "High Roller", "Tier 4 · jewel tones, gold-foil inlay"],
  ["pearl", "Mother of Pearl", "Tier 5 · pearlescent, iridescent sheen"],
  ["goldfoil", "Gold Foil", "Tier 6 · Flagship · hot-stamped gold, travelling glint"],
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 760 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/?demo=turn`);
  await page.waitForTimeout(600);
  await page.evaluate((SETS) => {
    const FX = window.__poker.FX;
    document.documentElement.dataset.chips = "none";
    const sheet = document.createElement("div");
    sheet.style.cssText = "position:fixed;inset:0;z-index:99;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px;background:#0b0f14;font-family:Inter,sans-serif;align-content:center";
    SETS.forEach(([id, name, sub], i) => {
      const tile = document.createElement("div");
      tile.dataset.chips = id;
      tile.style.cssText = "border-radius:16px;padding:14px 18px 22px;background:radial-gradient(ellipse at center,#1e7a4f 0%,#0c3d27 85%);border:1px solid #2d3644";
      tile.innerHTML = `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:16px"><span style="background:#f2c14e;color:#111;font-weight:800;border-radius:999px;width:24px;height:24px;display:inline-grid;place-items:center;font-size:13px">${i + 1}</span><span style="color:#fff;font-weight:700;font-size:18px">${name}</span><span style="color:#cfe0d6;font-size:13px">${sub}</span></div>`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:18px;align-items:flex-end;justify-content:center";
      for (const d of [1, 5, 25, 100, 500, 1000]) {
        // (each stack: four chips of one value)
        FX.setChipStyle(id);
        const st = FX.chipStack(0, 62, [d, d, d, d]);
        const col = document.createElement("div");
        col.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;color:#e6edf3;font-size:12px;font-weight:600";
        col.append(st, Object.assign(document.createElement("span"), { textContent: d.toLocaleString() }));
        row.append(col);
      }
      tile.append(row);
      sheet.append(tile);
    });
    document.body.append(sheet);
  }, SETS);
  await page.waitForTimeout(800);
  await page.screenshot({ path: "tests/out/chip-selection.png" });
  await browser.close();
})();
