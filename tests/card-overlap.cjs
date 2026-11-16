// Pixel-level check that no two parts of any card touch: node tests/card-overlap.cjs [baseUrl] [deck...]
// Renders all 52 cards per deck, screenshots each part on its own (corner rank, corner suit, centre art,
// frame), and reports any pair of parts whose painted pixels come within MIN_GAP pixels of each other.
const { chromium } = require("playwright");
const base = process.argv[2] || "http://localhost:8790";
const decks = process.argv.slice(3).length ? process.argv.slice(3) : ["ivory", "noir", "deco", "casino", "royal", "modern"];
const W = 120; // card width used for the check
const MIN_GAP = 3; // px at W=120 (about 1.6px on a 64px table card)
const PARTS = ["none", "rTL", "pTL", "rBR", "pBR", "art", "frame"];
const PAIRS = [
  ["rTL", "pTL"], ["rTL", "art"], ["pTL", "art"], ["rTL", "frame"], ["pTL", "frame"],
  ["rBR", "pBR"], ["rBR", "art"], ["pBR", "art"], ["rBR", "frame"], ["pBR", "frame"], ["art", "frame"],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?demo=turn`);
  await page.waitForTimeout(800);
  await page.addStyleTag({
    content: `
      #chk { position: fixed; inset: 0; z-index: 999; background: #808080; display: grid;
             grid-template-columns: repeat(13, ${W + 20}px); gap: 0; padding: 10px; align-content: start; }
      #chk .slot { padding: 10px; }
      #chk .card { --w: ${W}px; animation: none !important; box-shadow: none !important; }
      #chk .card::before { display: none !important; }
      #chk[data-show] .card * { visibility: hidden !important; }
      #chk[data-show]:not([data-show="frame"]) .card::after { visibility: hidden !important; }
      #chk[data-show="rTL"] .idx.tl .r, #chk[data-show="pTL"] .idx.tl .pip, #chk[data-show="pTL"] .idx.tl .pip *,
      #chk[data-show="rBR"] .idx.br .r, #chk[data-show="pBR"] .idx.br .pip, #chk[data-show="pBR"] .idx.br .pip *,
      #chk[data-show="art"] .art, #chk[data-show="art"] .art * { visibility: visible !important; }`,
  });

  let problems = 0;
  for (const deck of decks) {
    await page.evaluate((deck) => {
      document.getElementById("chk")?.remove();
      const chk = document.createElement("div");
      chk.id = "chk";
      chk.dataset.deck = deck;
      for (const s of "shdc") for (const r of "A23456789TJQK") {
        const slot = document.createElement("div");
        slot.className = "slot";
        slot.append(window.__poker.cardEl(r + s, { deck }));
        chk.append(slot);
      }
      document.body.append(chk);
    }, deck);
    await page.waitForTimeout(400);
    const shots = {};
    for (const part of PARTS) {
      await page.evaluate((part) => (document.getElementById("chk").dataset.show = part), part);
      await page.waitForTimeout(50);
      const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1900, height: 900 } });
      if (process.env.DUMP) require("fs").writeFileSync(`tests/out/chk-${deck}-${part}.png`, buf);
      shots[part] = buf.toString("base64");
    }
    const found = await page.evaluate(
      async ({ shots, PARTS, PAIRS, MIN_GAP }) => {
        const load = (b64) => new Promise((res) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            res(ctx.getImageData(0, 0, img.width, img.height));
          };
          img.src = "data:image/png;base64," + b64;
        });
        const data = {};
        for (const p of PARTS) data[p] = await load(shots[p]);
        const W = data.none.width;
        const cards = [...document.querySelectorAll("#chk .card")];
        const out = [];
        for (const card of cards) {
          const r = card.getBoundingClientRect();
          const x0 = Math.floor(r.left), y0 = Math.floor(r.top), w = Math.ceil(r.width), h = Math.ceil(r.height);
          const masks = {};
          for (const p of PARTS.slice(1)) {
            const m = new Uint8Array(w * h);
            let any = false;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
              const i = ((y0 + y) * W + (x0 + x)) * 4;
              const a = data.none.data, b = data[p].data;
              if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) { m[y * w + x] = 1; any = true; }
            }
            // drop the card's anti-aliased outer rim and isolated noise pixels (gradient dithering)
            const clean = new Uint8Array(w * h);
            any = false;
            for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
              if (!m[y * w + x]) continue;
              let n = 0;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += m[(y + dy) * w + x + dx];
              if (n >= 4) { clean[y * w + x] = 1; any = true; }
            }
            masks[p] = any ? clean : null;
          }
          for (const [a, b] of PAIRS) {
            const ma = masks[a], mb = masks[b];
            if (!ma || !mb) continue;
            let minD = Infinity;
            // distance check: for each pixel of a, look for b within MIN_GAP
            outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
              if (!ma[y * w + x]) continue;
              for (let dy = -MIN_GAP; dy <= MIN_GAP; dy++) for (let dx = -MIN_GAP; dx <= MIN_GAP; dx++) {
                const yy = y + dy, xx = x + dx;
                if (yy < 0 || xx < 0 || yy >= h || xx >= w || !mb[yy * w + xx]) continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                if (d < minD) minD = d;
                if (minD === 0) break outer;
              }
            }
            if (minD <= MIN_GAP) out.push(`${card.dataset.card}: ${a} vs ${b} ${minD === 0 ? "OVERLAP" : `gap ${minD}px`}`);
          }
        }
        return out;
      },
      { shots, PARTS, PAIRS, MIN_GAP },
    );
    problems += found.length;
    // group by pair type for a readable summary
    const byPair = {};
    for (const f of found) {
      const [card, rest] = f.split(": ");
      const key = rest.replace(/ (OVERLAP|gap \d+px)$/, "");
      (byPair[key] ??= []).push(card + (rest.endsWith("OVERLAP") ? "!" : ""));
    }
    console.log(`\n== ${deck}: ${found.length ? found.length + " problems" : "clean"}`);
    for (const [k, v] of Object.entries(byPair)) console.log(`  ${k}: ${v.join(" ")}`);
  }
  await browser.close();
  console.log(`\nTotal problems: ${problems}  (card! = parts overlap, plain = closer than ${MIN_GAP}px)`);
  process.exit(problems ? 1 : 0);
})();
