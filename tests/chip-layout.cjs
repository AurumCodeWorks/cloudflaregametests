// Checks chips at rest on the table never overlap numbers, cards or nameplates (desktop + phone):
// node tests/chip-layout.cjs [baseUrl]
const { chromium, devices } = require("playwright");
const base = process.argv[2] || "http://localhost:8787";
const AT = [1300, 3400, 5500, 7500, 9400, 10900, 12200, 13900, 15400, 16600, 17900, 19400, 20700]; // after each step settles
(async () => {
  const browser = await chromium.launch();
  let total = 0;
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 800 } }], ["phone", devices["iPhone 13"]]]) {
    const page = await browser.newPage(opts);
    await page.goto(`${base}/?demo=play&room=classic&deck=modern&chips=casino&celebration=glow`);
    const t0 = Date.now();
    for (const [k, at] of AT.entries()) {
      await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
      const found = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const hit = (a, b, pad = 2) => a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
        const out = [];
        const stacks = [...document.querySelectorAll(".zone:not(.empty) .zone-chips, #pot-pile")].filter((s) => s.children.length);
        const others = [
          ...[...document.querySelectorAll(".pot")].map((e) => ["pot label", e]),
          ...[...document.querySelectorAll(".street")].filter((e) => e.textContent).map((e) => ["street label", e]),
          ...[...document.querySelectorAll(".zone:not(.empty) .zone-amt")].filter((e) => e.textContent).map((e) => [`bet amount ${e.textContent}`, e]),
          ...[...document.querySelectorAll(".seat .card, #board .card")].map((e) => [`card ${e.dataset.card || "back"}`, e]),
          ...[...document.querySelectorAll(".plate")].map((e) => [`plate ${e.querySelector(".name")?.textContent}`, e]),

        ];
        for (const s of stacks) {
          const sr = box(s);
          const where = s.closest(".zone") ? "bet chips" : "pot chips";
          for (const [name, el] of others) {
            if (el.contains(s) || (s.closest(".zone") && s.closest(".zone").contains(el))) continue;
            if (hit(sr, box(el))) out.push(`${where} touch ${name}`);
          }
        }
        // chips touching other chips (different stacks)
        stacks.forEach((a, i) => stacks.forEach((b, j) => {
          if (j <= i) return;
          if (hit(box(a), box(b), 1)) out.push(`${a.closest(".zone") ? "bet" : "pot"} chips touch ${b.closest(".zone") ? "bet" : "pot"} chips`);
        }));
        // labels hidden under cards or nameplates
        for (const lbl of [...document.querySelectorAll(".street, .pot")]) {
          if (!lbl.textContent) continue;
          for (const el of document.querySelectorAll(".seat .card, .plate, .zone:not(.empty) .zone-chips"))
            if (hit(box(lbl), box(el), 0)) out.push(`${lbl.className} label under ${el.className.split(" ")[0]}`);
        }
        return [...new Set(out)];
      });
      if (found.length) { total += found.length; console.log(`${label} step ${k + 1}: ${found.join(" | ")}`); }
      if ([2, 4, 6].includes(k)) await page.screenshot({ path: `tests/out/layout-${label}-${k + 1}.png` });
    }
    await page.close();
  }
  await browser.close();
  console.log(total ? `${total} chip layout problems` : "chips at rest touch nothing (desktop + phone)");
  process.exit(total ? 1 : 0);
})();
