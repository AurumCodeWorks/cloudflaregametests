// Renders every room (with its matching collection deck) into one sheet: node tests/room-sheet.cjs [baseUrl]
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
const ROOMS = [
  ["classic", "modern", "Classic", "Tier 1 · Free · green felt, walnut rail"],
  ["midnight", "casino", "Midnight", "Tier 2 · After Hours Collection"],
  ["vegas", "deco", "Vegas", "Tier 3 · High Roller Collection"],
  ["riviera", "royal", "Riviera", "Tier 4 · Monaco Collection"],
  ["speakeasy", "noir", "Speakeasy", "Tier 5 · Prohibition Collection"],
  ["penthouse", "ivory", "Penthouse", "Tier 6 · Flagship · Penthouse Collection"],
];
(async () => {
  const browser = await chromium.launch();
  const shots = [];
  for (const [room, deck] of ROOMS) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/?demo=showdown&room=${room}&deck=${deck}`);
    await page.waitForTimeout(1200);
    shots.push((await page.screenshot({ clip: { x: 0, y: 57, width: 1040, height: 610 } })).toString("base64"));
    await page.close();
  }
  const sheet = await browser.newPage({ viewport: { width: 1400, height: 1390 }, deviceScaleFactor: 2 });
  await sheet.setContent(`<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap"></head>
  <body style="margin:0;background:#0b0f14;font-family:Inter,sans-serif;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:18px">
  ${ROOMS.map(([room, deck, name, sub], i) => `<figure style="margin:0;background:#141a22;border:1px solid #2d3644;border-radius:14px;overflow:hidden">
    <img src="data:image/png;base64,${shots[i]}" style="width:100%;display:block">
    <figcaption style="padding:10px 14px;color:#fff;display:flex;gap:10px;align-items:baseline">
      <span style="background:#f2c14e;color:#111;font-weight:800;border-radius:999px;width:24px;height:24px;display:inline-grid;place-items:center;font-size:13px">${i + 1}</span>
      <b style="font-size:17px">${name}</b><span style="color:#9fb0c2;font-size:13px">${sub}</span></figcaption></figure>`).join("")}
  </body></html>`);
  await sheet.waitForTimeout(800);
  await sheet.screenshot({ path: "tests/out/room-selection.png", fullPage: true });
  await browser.close();
})();
