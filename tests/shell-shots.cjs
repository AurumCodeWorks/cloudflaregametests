// Screenshots of every shell screen: node tests/shell-shots.cjs [baseUrl]
const { chromium, devices } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const page = async (opts) => { const p = await b.newPage(opts); p.on("pageerror", (e) => errs.push(e.message)); return p; };
  const D = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  let p = await page(D);
  await p.goto(`${base}/`); await p.waitForTimeout(900);
  await p.screenshot({ path: "tests/out/shell-login.png" });
  await p.evaluate(() => { document.getElementById("lobby-name").textContent = "Sam"; document.getElementById("wallet-balance").textContent = "1,000"; });
  await p.evaluate(() => { for (const s of ["login", "lobby", "table"]) document.getElementById(`screen-${s}`).hidden = s !== "lobby"; document.querySelector(".wallet").hidden = false; });
  await p.waitForTimeout(300);
  await p.screenshot({ path: "tests/out/shell-lobby.png" });
  await p.close();
  p = await page(D);
  await p.goto(`${base}/?demo=showroom&room=penthouse&deck=ivory&chips=goldfoil&celebration=goldrush&loop=0`);
  await p.waitForTimeout(13300); await p.screenshot({ path: "tests/out/shell-table.png" });
  await p.click("#history-btn"); await p.waitForTimeout(700); await p.screenshot({ path: "tests/out/shell-drawer.png" });
  await p.close();
  p = await page(devices["iPhone 13"]);
  await p.goto(`${base}/?demo=showroom&room=classic&deck=ivory&chips=casino&loop=0`);
  await p.waitForTimeout(13300); await p.screenshot({ path: "tests/out/shell-phone.png", fullPage: true });
  await p.close();
  await b.close();
  console.log(errs.length ? errs.join("\n") : "no page errors");
})();
