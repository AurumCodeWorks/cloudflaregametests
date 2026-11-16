// Animation engine: flying cards and chips, card flips, number ticker, and win celebrations.
// Everything respects prefers-reduced-motion (elements simply appear in place).
export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let layer;
function fxLayer() {
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "fx";
    document.body.append(layer);
  }
  return layer;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

// ------------------------------------------------------------------ chips
// Modelled on real casino chips: base colour, edge-spot inserts that run through the chip
// (so they show on the face AND the side), a pressed mold ring, and a centre inlay with the value.
// Ceramic chips are fully printed instead, and their side pattern does not line up with the face.
const DENOMS = [1000, 500, 100, 25, 5, 1];
const LABEL = { 1: "1", 5: "5", 25: "25", 100: "100", 500: "500", 1000: "1K" };
const CREAM = "#f3eee2";

export const CHIP_STYLES = {
  // Tier 1 (free): classic casino clay. Six single-colour inserts, suited mold, ivory inlay.
  casino: {
    name: "Casino Clay", inserts: 6, spotDeg: 15, mold: true,
    d: {
      1: { base: "#efece4", spots: ["#2a5db0"], inlay: "#fbf8f0", text: "#2a5db0" },
      5: { base: "#b51f29", spots: [CREAM], inlay: "#fbf8f0", text: "#b51f29" },
      25: { base: "#1d7a3d", spots: [CREAM], inlay: "#fbf8f0", text: "#1d7a3d" },
      100: { base: "#1a1a1c", spots: [CREAM], inlay: "#fbf8f0", text: "#1a1a1c" },
      500: { base: "#5a2a86", spots: ["#f2d24a"], inlay: "#fbf8f0", text: "#5a2a86" },
      1000: { base: "#e3a51c", spots: ["#1a1a1c"], inlay: "#fbf8f0", text: "#8a5a00" },
    },
  },
  // Tier 2: tri-colour inserts (three clay colours side by side in each insert), coloured inlay ring.
  tricolour: {
    name: "Tri-Colour Clay", inserts: 4, spotDeg: 24, mold: true, inlayRing: true,
    d: {
      1: { base: "#efece4", spots: ["#c62828", CREAM, "#2a5db0"], inlay: "#fbf8f0", text: "#2a5db0" },
      5: { base: "#b51f29", spots: [CREAM, "#1f4fa0", CREAM], inlay: "#fbf8f0", text: "#b51f29" },
      25: { base: "#1d7a3d", spots: [CREAM, "#f2c14e", CREAM], inlay: "#fbf8f0", text: "#1d7a3d" },
      100: { base: "#1a1a1c", spots: ["#c62828", CREAM, "#c62828"], inlay: "#fbf8f0", text: "#1a1a1c" },
      500: { base: "#5a2a86", spots: ["#f2d24a", CREAM, "#f2d24a"], inlay: "#fbf8f0", text: "#5a2a86" },
      1000: { base: "#e3a51c", spots: ["#1a1a1c", CREAM, "#1a1a1c"], inlay: "#fbf8f0", text: "#8a5a00" },
    },
  },
  // Tier 3: printed ceramic. Edge-to-edge print, no mold, glossy, side stripes offset from the face.
  ceramic: {
    name: "Ceramic Pro", printed: true, gloss: true,
    d: {
      1: { base: "#f4f6fa", accent: "#2f6fe0", inlay: "#2f6fe0", text: "#ffffff" },
      5: { base: "#d7262f", accent: "#ffffff", inlay: "#ffffff", text: "#d7262f" },
      25: { base: "#13955a", accent: "#ffffff", inlay: "#ffffff", text: "#13955a" },
      100: { base: "#202228", accent: "#f2c14e", inlay: "#f2c14e", text: "#202228" },
      500: { base: "#7b2cbf", accent: "#ffffff", inlay: "#ffffff", text: "#7b2cbf" },
      1000: { base: "#f59e0b", accent: "#1a1a1c", inlay: "#1a1a1c", text: "#f59e0b" },
    },
  },
  // Tier 4: high roller. Jewel-tone bodies, eight cream inserts, dark inlay with gold-foil ring and value.
  highroller: {
    name: "High Roller", inserts: 8, spotDeg: 9, mold: true, foilInlay: true,
    d: {
      1: { base: "#d8d2c4", spots: ["#5b4a2a"], inlay: "#2a261f", text: "gold" },
      5: { base: "#6e0f20", spots: [CREAM], inlay: "#3c0812", text: "gold" },
      25: { base: "#0d4d3a", spots: [CREAM], inlay: "#062a20", text: "gold" },
      100: { base: "#0d0d0f", spots: [CREAM], inlay: "#0d0d0f", text: "gold" },
      500: { base: "#1d2f6b", spots: [CREAM], inlay: "#0f1a3e", text: "gold" },
      1000: { base: "#3d1b52", spots: [CREAM], inlay: "#221030", text: "gold" },
    },
  },
  // Tier 5: mother-of-pearl. Pearlescent bodies with an iridescent sheen and a pearl inlay.
  pearl: {
    name: "Mother of Pearl", inserts: 6, spotDeg: 13, mold: true, pearl: true,
    d: {
      1: { base: "#f1eee8", spots: ["#7f9cc9"], inlay: "#fffdf9", text: "#4f6f9f" },
      5: { base: "#e6a9b1", spots: ["#9e3f4c"], inlay: "#fffdf9", text: "#9e3f4c" },
      25: { base: "#a9d6bd", spots: ["#2f7a52"], inlay: "#fffdf9", text: "#2f7a52" },
      100: { base: "#86889a", spots: ["#2e3040"], inlay: "#fffdf9", text: "#2e3040" },
      500: { base: "#bfa9de", spots: ["#5a3d8a"], inlay: "#fffdf9", text: "#5a3d8a" },
      1000: { base: "#e8d29a", spots: ["#8a6a1a"], inlay: "#fffdf9", text: "#7a5a10" },
    },
  },
  // Tier 6 (flagship): gold foil. Hot-stamped gold rim, gold inserts and inlay, travelling glint.
  goldfoil: {
    name: "Gold Foil", inserts: 6, spotDeg: 12, foilRim: true, foilInlay: true, glint: true, mold: true,
    d: {
      1: { base: "#ece8de", spots: ["gold"], inlay: "#1a1712", text: "gold" },
      5: { base: "#8e1420", spots: ["gold"], inlay: "#1a0a0c", text: "gold" },
      25: { base: "#0f5c3e", spots: ["gold"], inlay: "#06231a", text: "gold" },
      100: { base: "#111113", spots: ["gold"], inlay: "#111113", text: "gold" },
      500: { base: "#22337a", spots: ["gold"], inlay: "#0e1638", text: "gold" },
      1000: { base: "#4a1f62", spots: ["gold"], inlay: "#1f0d2a", text: "gold" },
    },
  },
};
let chipStyle = "casino";
export function setChipStyle(name) { if (CHIP_STYLES[name]) chipStyle = name; }
export function chipColors(name = chipStyle) { return [5, 25, 100, 500].map((d) => CHIP_STYLES[name].d[d].base); }

const fillOf = (c) => (c === "gold" ? "url(#ink-gold)" : c);
const P = (r, a) => [+(r * Math.cos(a)).toFixed(2), +(r * Math.sin(a)).toFixed(2)];
function sector(r1, r2, a1, a2) {
  const [x1, y1] = P(r2, a1), [x2, y2] = P(r2, a2), [x3, y3] = P(r1, a2), [x4, y4] = P(r1, a1);
  const big = a2 - a1 > Math.PI ? 1 : 0;
  return `M${x1},${y1}A${r2},${r2} 0 ${big} 1 ${x2},${y2}L${x3},${y3}A${r1},${r1} 0 ${big} 0 ${x4},${y4}Z`;
}
const isDark = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 140;
};

/** Insert segments as [startAngle, endAngle, colour], shared by the face and the side. */
function insertSegments(st, c, rot) {
  if (st.printed) return [];
  const out = [];
  const w = (st.spotDeg * Math.PI) / 180;
  for (let k = 0; k < st.inserts; k++) {
    const mid = rot + (k * 2 * Math.PI) / st.inserts;
    const n = c.spots.length;
    for (let j = 0; j < n; j++) out.push([mid - w / 2 + (j * w) / n, mid - w / 2 + ((j + 1) * w) / n, c.spots[j]]);
  }
  return out;
}

function chipFace(st, c, denom, rot) {
  let s = `<circle r="50" fill="${c.base}"/>`;
  if (st.printed) {
    for (let k = 0; k < 24; k++) {
      const a = rot + (k * Math.PI) / 12;
      s += `<path d="${sector(41, 49, a, a + Math.PI / 24)}" fill="${c.accent}"/>`;
    }
    s += `<circle r="38" fill="none" stroke="${c.accent}" stroke-width="1.6"/><circle r="34.5" fill="none" stroke="${c.accent}" stroke-width=".7" stroke-dasharray="2 2"/>`;
  } else {
    for (const [a1, a2, col] of insertSegments(st, c, rot)) s += `<path d="${sector(37, 50, a1, a2)}" fill="${fillOf(col)}"/>`;
  }
  if (st.foilRim) s += `<path d="${sector(46.5, 50, 0, Math.PI * 2 - 0.0001)}" fill="url(#ink-gold)"/><circle r="36.6" fill="none" stroke="url(#ink-gold)" stroke-width="1.4"/>`;
  if (st.mold) {
    const ink = isDark(c.base) ? "rgba(255,255,255,.17)" : "rgba(0,0,0,.15)";
    s += `<circle r="36.4" fill="none" stroke="rgba(0,0,0,.2)" stroke-width=".8"/>`;
    ["s", "h", "c", "d", "s", "h", "c", "d"].forEach((suit, k) => {
      const a = rot + 0.39 + (k * Math.PI) / 4;
      const [x, y] = P(31.2, a);
      s += `<use href="#s-${suit}" x="${x - 3.6}" y="${y - 3.6}" width="7.2" height="7.2" fill="${ink}" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(1)} ${x} ${y})"/>`;
    });
  }
  // Inlay
  const textFill = fillOf(c.text);
  s += `<circle r="26.5" fill="${c.inlay}"/>`;
  if (st.foilInlay) s += `<circle r="25" fill="none" stroke="url(#ink-gold)" stroke-width="1.8"/><circle r="21.8" fill="none" stroke="url(#ink-gold)" stroke-width=".5"/>`;
  else s += `<circle r="25.2" fill="none" stroke="${st.inlayRing ? c.base : "rgba(0,0,0,.12)"}" stroke-width="${st.inlayRing ? 2.6 : 0.6}"/>`;
  const label = LABEL[denom];
  const fs = label.length >= 3 ? 15.5 : 19;
  s += `<text y="${(fs * 0.35).toFixed(1)}" text-anchor="middle" font-family="Roboto Slab, Georgia, serif" font-weight="800" font-size="${fs}" fill="${textFill}">${label}</text>`;
  s += `<text font-family="Roboto Slab, Georgia, serif" font-weight="700" font-size="4.6" letter-spacing="1.1" fill="${textFill}" opacity=".8"><textPath href="#chip-arc" startOffset="50%" text-anchor="middle">CARD TABLE</textPath></text>`;
  if (st.pearl) s += `<circle r="50" fill="url(#chip-pearl)" opacity=".75" style="mix-blend-mode:soft-light"/>`;
  s += `<circle r="50" fill="url(#chip-sheen)"/>`;
  if (st.gloss) s += `<ellipse cx="-14" cy="-20" rx="26" ry="14" fill="#fff" opacity=".22" transform="rotate(-28 -14 -20)"/>`;
  if (st.glint) s += `<circle r="50" fill="url(#chip-glint)"/>`;
  s += `<circle r="49.6" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1"/>`;
  return s;
}

function chipSide(st, c, rot, T, RY) {
  const band = (a1, a2) => {
    const pts = [];
    for (let k = 0; k <= 6; k++) { const a = a1 + ((a2 - a1) * k) / 6; pts.push([50 * Math.cos(a), RY * Math.sin(a)]); }
    const top = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`);
    const bot = pts.reverse().map(([x, y]) => `${x.toFixed(2)},${(y + T).toFixed(2)}`);
    return `M${top.join("L")}L${bot.join("L")}Z`;
  };
  let s = `<path d="M-50,0A50,${RY} 0 0 0 50,0L50,${T}A50,${RY} 0 0 1 -50,${T}Z" fill="${st.foilRim ? "url(#ink-gold)" : c.base}"/>`;
  // Inserts visible on the front half (0..PI); printed chips get an offset printed edge instead
  const segs = st.printed
    ? Array.from({ length: 18 }, (_, k) => { const a = rot + 0.13 + (k * Math.PI) / 9; return [a, a + Math.PI / 18, c.accent]; })
    : insertSegments(st, c, rot);
  const TAU = 2 * Math.PI;
  if (!st.foilRim)
    for (const [s1, s2, col] of segs) {
      const w = s2 - s1;
      const a1 = ((s1 % TAU) + TAU) % TAU;
      for (const start of [a1, a1 - TAU]) {
        const lo = Math.max(start, 0.02), hi = Math.min(start + w, Math.PI - 0.02);
        if (hi > lo) s += `<path d="${band(lo, hi)}" fill="${fillOf(col)}"/>`;
      }
    }
  s += `<path d="M-50,0A50,${RY} 0 0 0 50,0L50,${T}A50,${RY} 0 0 1 -50,${T}Z" fill="url(#chip-side)"/>`;
  s += `<path d="M-50,${T}A50,${RY} 0 0 0 50,${T}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="1"/>`;
  return s;
}

export function chipBreakdown(amount, max = 7) {
  const out = [];
  let a = amount;
  for (const d of DENOMS) while (a >= d && out.length < max) { out.push(d); a -= d; }
  return out; // largest first = bottom of the stack
}

/** A stack of chips in 3/4 view. `size` is the chip diameter in px. */
export function chipStack(amount, size = 20, denoms = null) {
  const st = CHIP_STYLES[chipStyle];
  const chips = denoms ?? chipBreakdown(amount);
  const T = 9, RY = 27; // chip thickness and tilt (top face drawn as an ellipse)
  const n = Math.max(1, chips.length);
  const minY = -(n - 1) * T - RY - 2;
  const h = (n - 1) * T + 2 * RY + T + 4;
  let body = "";
  chips.forEach((d, i) => {
    const c = st.d[d];
    const rot = ((i * 53 + d) % 360) * (Math.PI / 180); // natural, slightly random insert alignment
    const dx = (((i * 37) % 5) - 2) * 0.7;
    body += `<g transform="translate(${dx},${-i * T})">${chipSide(st, c, rot, T, RY)}<g transform="scale(1,${RY / 50})">${chipFace(st, c, d, rot)}</g></g>`;
  });
  const el = document.createElement("div");
  el.className = "stack";
  el.style.width = `${size * 1.04}px`;
  el.style.height = `${(size * 1.04 * h) / 104}px`;
  el.innerHTML = `<svg viewBox="-52 ${minY} 104 ${h}" aria-hidden="true">${body}</svg>`;
  return el;
}

/** A pot rendered as several stacks side by side. */
export function chipPile(amount, size = 20) {
  const wrap = document.createElement("div");
  wrap.className = "pot-stack";
  let rest = amount;
  for (let i = 0; i < 4 && rest > 0; i++) {
    const part = i === 3 ? rest : Math.max(1, Math.ceil(rest / (4 - i)));
    wrap.append(chipStack(part, size));
    rest -= part;
  }
  return wrap;
}

// ------------------------------------------------------------------ flights
/** Fly `el` from one rect to another (arc), then remove it. */
export async function fly(el, from, to, { duration = 450, delay = 0, lift = 40, endScale = 1, fade = false, hold = false } = {}) {
  if (reduced) return;
  // Unless asked to "hold" (wait visibly at the start, like a deck pile), appear only when the flight begins
  if (delay && !hold) { await wait(delay); delay = 0; }
  const L = fxLayer();
  Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: 0 });
  L.append(el);
  const a = center(from), b = center(to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const s = to.width / from.width || 1;
  const anim = el.animate(
    [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${dx / 2}px, ${dy / 2 - lift}px) scale(${(1 + s * endScale) / 2})`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s * endScale})`, opacity: fade ? 0 : 1 },
    ],
    { duration, delay, easing: "cubic-bezier(.3,.7,.3,1)", fill: "both" },
  );
  return anim.finished.then(() => el.remove(), () => el.remove());
}

/** Deal: card backs fly from the deck to each target card, which is hidden until its back lands. */
export function deal(targets, deckRect, makeBack) {
  targets.forEach(({ el }, i) => {
    if (reduced) return;
    el.style.opacity = "0";
    const back = makeBack();
    const to = el.getBoundingClientRect();
    const from = new DOMRect(center(deckRect).x - to.width / 2, center(deckRect).y - to.height / 2, to.width, to.height);
    fly(back, from, to, { duration: 380, delay: i * 85, lift: 18, hold: true }).then(() => (el.style.opacity = ""));
  });
}

/** Flip a card face-up in place: a back rotates away, then the face rotates in. */
export async function flipIn(el, makeBack, delay = 0) {
  if (reduced) return;
  el.style.opacity = "0";
  await wait(delay);
  const r = el.getBoundingClientRect();
  const back = makeBack();
  Object.assign(back.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: 0 });
  fxLayer().append(back);
  await back.animate([{ transform: "perspective(700px) rotateY(0)" }, { transform: "perspective(700px) rotateY(90deg)" }], { duration: 170, easing: "ease-in", fill: "both" }).finished;
  back.remove();
  el.style.opacity = "";
  el.animate([{ transform: "perspective(700px) rotateY(-90deg)" }, { transform: "perspective(700px) rotateY(0)" }], { duration: 190, easing: "ease-out" });
}

/** Folded cards slide into the middle and fade. */
export function muck(rects, toRect, makeBack) {
  rects.forEach((r, i) => fly(makeBack(), r, new DOMRect(center(toRect).x - r.width / 2, center(toRect).y - r.height / 2, r.width, r.height), { duration: 420, delay: i * 60, lift: 10, endScale: 0.7, fade: true }));
}

export function flyChips(amount, from, to, opts = {}) {
  if (!from || !to || amount <= 0) return Promise.resolve();
  const st = chipStack(amount, opts.size ?? 28);
  const w = opts.size ?? 28;
  const f = new DOMRect(center(from).x - w / 2, center(from).y - w / 2, w, w);
  const t = new DOMRect(center(to).x - w / 2, center(to).y - w / 2, w, w);
  return fly(st, f, t, { duration: 520, lift: 30, ...opts });
}

/** FLIP: animate an element from its previous rect to where it is now. */
export function glideFrom(el, oldRect) {
  if (reduced || !el || !oldRect) return;
  const r = el.getBoundingClientRect();
  const dx = oldRect.left - r.left, dy = oldRect.top - r.top;
  if (Math.abs(dx) + Math.abs(dy) < 1) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }], { duration: 650, easing: "cubic-bezier(.3,.7,.3,1)" });
}

export function tick(el, from, to, duration = 450) {
  if (reduced || from === to) { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / duration);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ particles
function particleCanvas() {
  const c = document.createElement("canvas");
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  c.style.width = `${innerWidth}px`;
  c.style.height = `${innerHeight}px`;
  fxLayer().append(c);
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  return { c, ctx };
}

const GOLD = ["#fff1b8", "#f2c14e", "#d9b65e", "#b8913c"];
const CONFETTI = ["#f2c14e", "#e53935", "#2ecc71", "#3b82f6", "#b26bff", "#ffffff", "#ff8a3d"];

function draw(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
  if (p.shape === "rect") {
    ctx.fillStyle = p.color;
    ctx.scale(1, Math.cos(p.flip));
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
  } else if (p.shape === "coin") {
    ctx.scale(Math.max(0.15, Math.abs(Math.cos(p.flip))), 1);
    const g = ctx.createLinearGradient(-p.size, -p.size, p.size, p.size);
    g.addColorStop(0, "#8a6a2b"); g.addColorStop(0.45, "#fff1b8"); g.addColorStop(0.6, "#f2c14e"); g.addColorStop(1, "#7d5e22");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, p.size, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(90,60,10,.55)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, p.size * 0.68, 0, Math.PI * 2); ctx.stroke();
  } else if (p.shape === "chip") {
    ctx.scale(1, Math.max(0.2, Math.abs(Math.cos(p.flip))));
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(0, 0, p.size, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = p.size * 0.28; ctx.setLineDash([p.size * 0.5, p.size * 0.6]);
    ctx.beginPath(); ctx.arc(0, 0, p.size * 0.82, 0, Math.PI * 2); ctx.stroke();
  } else if (p.shape === "spark") {
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size * 3);
    g.addColorStop(0, p.color); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, p.size * 3, 0, Math.PI * 2); ctx.fill();
  } else if (p.shape === "star") {
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = p.color;
    const s = p.size * (0.6 + 0.4 * Math.sin(p.age * 0.02));
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rr = i % 2 ? s * 0.25 : s;
      ctx.lineTo(Math.cos((i * Math.PI) / 4) * rr, Math.sin((i * Math.PI) / 4) * rr);
    }
    ctx.fill();
  }
  ctx.restore();
}

/** Run a particle simulation. spawn(t) may return new particles each frame. */
function runParticles({ duration, spawn, trails = false }) {
  const { c, ctx } = particleCanvas();
  const ps = [];
  const t0 = performance.now();
  let last = t0;
  return new Promise((resolve) => {
    const frame = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      const t = now - t0;
      if (t < duration) ps.push(...(spawn(t, dt) ?? []));
      if (trails) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,.22)";
        ctx.fillRect(0, 0, innerWidth, innerHeight);
        ctx.globalCompositeOperation = "source-over";
      } else ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.age += dt;
        p.vy += (p.g ?? 0.0012) * dt;
        p.vx *= p.drag ?? 1;
        p.vy *= p.drag ?? 1;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += (p.vr ?? 0) * dt;
        p.flip = (p.flip ?? 0) + (p.vf ?? 0) * dt;
        if (p.burst && p.age >= p.burstAt) { ps.splice(i, 1); ps.push(...p.burst(p)); continue; }
        if (p.age >= p.life) { ps.splice(i, 1); continue; }
        draw(ctx, p);
      }
      if (t < duration || ps.length) requestAnimationFrame(frame);
      else { c.remove(); resolve(); }
    };
    requestAnimationFrame(frame);
  });
}
const rand = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------------ celebrations
export const CELEBRATIONS = ["glow", "chipshower", "confetti", "spotlight", "fireworks", "goldrush"];

function floatText(text, x, y, delay = 0) {
  if (reduced) return;
  const el = document.createElement("div");
  el.className = "float-win";
  el.textContent = text;
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  fxLayer().append(el);
  el.animate(
    [{ transform: "translate(-50%,-30%) scale(.6)", opacity: 0 }, { transform: "translate(-50%,-90%) scale(1.1)", opacity: 1, offset: 0.25 }, { transform: "translate(-50%,-260%) scale(1)", opacity: 0 }],
    { duration: 1900, delay, easing: "cubic-bezier(.2,.8,.3,1)", fill: "both" },
  ).finished.then(() => el.remove());
}

function overlay(cls, styles = {}) {
  const el = document.createElement("div");
  el.className = cls;
  Object.assign(el.style, styles);
  fxLayer().append(el);
  return el;
}

/**
 * Play a win celebration around the winner's seat plate.
 * style: one of CELEBRATIONS. chipColors: colours of the active chip set (for the chip shower).
 */
export async function celebrate(style, plateEl, amount, { chipColors = ["#c62828", "#2e7d32", "#1d1d1f", "#6a1b9a"] } = {}) {
  const r = plateEl.getBoundingClientRect();
  const { x, y } = center(r);
  floatText(`+${amount.toLocaleString()}`, x, r.top - 6);
  if (reduced || style === "glow") return wait(1900);

  if (style === "chipshower") {
    return runParticles({
      duration: 700,
      spawn: (t) => t < 700 ? Array.from({ length: 3 }, () => ({
        shape: "chip", x: x + rand(-30, 30), y: r.top, vx: rand(-0.35, 0.35), vy: rand(-0.95, -0.6), g: 0.0022,
        size: rand(7, 10), color: chipColors[(Math.random() * chipColors.length) | 0], rot: 0, vr: rand(-0.01, 0.01), vf: rand(0.01, 0.03), age: 0, life: 2200,
      })) : [],
    });
  }

  if (style === "confetti") {
    const burst = (sx, dir) => Array.from({ length: 70 }, () => ({
      shape: "rect", x: sx, y: y, vx: dir * rand(0.25, 0.9), vy: rand(-1.1, -0.45), g: 0.0016, drag: 0.992,
      size: rand(7, 12), color: CONFETTI[(Math.random() * CONFETTI.length) | 0], rot: rand(0, 6), vr: rand(-0.02, 0.02), vf: rand(0.01, 0.04), age: 0, life: 2600,
    }));
    let fired = false;
    return runParticles({ duration: 60, spawn: () => (fired ? [] : ((fired = true), [...burst(r.left - 10, -1), ...burst(r.right + 10, 1)])) });
  }

  if (style === "spotlight") {
    const spot = overlay("fx-spot", { "--x": `${x}px`, "--y": `${y}px` });
    spot.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 2800, fill: "both" }).finished.then(() => spot.remove());
    const label = overlay("fx-label", { left: `${x}px`, top: `${r.top - 128}px` });
    label.textContent = "WINNER";
    label.animate([{ opacity: 0, letterSpacing: ".6em" }, { opacity: 1, letterSpacing: ".2em", offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 2800, fill: "both" }).finished.then(() => label.remove());
    return runParticles({
      duration: 2200,
      spawn: (t, dt) => Math.random() < dt / 60 ? [{ shape: "star", x: x + rand(-90, 90), y: y + rand(-60, 30), vx: 0, vy: -0.02, g: 0, size: rand(5, 9), color: "#fff6d5", rot: 0, age: 0, life: 900 }] : [],
    });
  }

  if (style === "fireworks") {
    const rocket = (delay, bx) => ({
      shape: "spark", x: bx, y: innerHeight * 0.85, vx: rand(-0.05, 0.05), vy: -0.75, g: 0.0006, size: 2.4, color: "#ffe9b0", rot: 0, age: -delay, life: 99999, burstAt: 650,
      burst: (p) => {
        const col = CONFETTI[(Math.random() * 6) | 0];
        return Array.from({ length: 70 }, (_, i) => {
          const a = (i / 70) * Math.PI * 2, sp = rand(0.12, 0.32);
          return { shape: "spark", x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.00025, drag: 0.985, size: 2, color: col, rot: 0, age: 0, life: 1300 };
        });
      },
    });
    let launched = 0;
    return runParticles({
      duration: 1500, trails: true,
      spawn: (t) => {
        const out = [];
        while (launched < 4 && t >= launched * 320) { out.push(rocket(0, x + [-160, 140, -40, 60][launched])); launched++; }
        return out;
      },
    });
  }

  if (style === "goldrush") {
    const rays = overlay("fx-rays", { left: `${x}px`, top: `${y}px` });
    rays.animate([{ opacity: 0, transform: "translate(-50%,-50%) rotate(0deg) scale(.6)" }, { opacity: 1, transform: "translate(-50%,-50%) rotate(40deg) scale(1)", offset: 0.25 }, { opacity: 1, offset: 0.8 }, { opacity: 0, transform: "translate(-50%,-50%) rotate(110deg) scale(1.1)" }], { duration: 3200, fill: "both" }).finished.then(() => rays.remove());
    const felt = document.getElementById("felt")?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const head = overlay("fx-headline", { left: `${felt.left + felt.width / 2}px`, top: `${felt.top + felt.height * 0.27}px` });
    head.innerHTML = `BIG WIN<small>+${amount.toLocaleString()}</small>`;
    const scrim = overlay("fx-scrim", { left: head.style.left, top: head.style.top });
    head.before(scrim);
    scrim.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 3200, fill: "both" }).finished.then(() => scrim.remove());
    head.animate([{ opacity: 0, transform: "translate(-50%,-50%) scale(.4)" }, { opacity: 1, transform: "translate(-50%,-50%) scale(1.08)", offset: 0.18 }, { transform: "translate(-50%,-50%) scale(1)", offset: 0.28 }, { opacity: 1, offset: 0.85 }, { opacity: 0, transform: "translate(-50%,-50%) scale(1)" }], { duration: 3200, fill: "both" }).finished.then(() => head.remove());
    head.animate([{ backgroundPosition: "150% 0" }, { backgroundPosition: "-50% 0" }], { duration: 1400, delay: 500, iterations: 2, easing: "ease-in-out" });
    return runParticles({
      duration: 1800,
      spawn: (t, dt) => [
        ...Array.from({ length: Math.round(dt / 8) }, () => ({ shape: "coin", x: x + rand(-20, 20), y: r.top, vx: rand(-0.4, 0.4), vy: rand(-1.15, -0.75), g: 0.0024, size: rand(6, 9), rot: 0, vf: rand(0.008, 0.02), age: 0, life: 2300 })),
        ...(Math.random() < dt / 30 ? [{ shape: "star", x: x + rand(-160, 160), y: y + rand(-120, 40), vx: 0, vy: 0, g: 0, size: rand(6, 11), color: GOLD[(Math.random() * 4) | 0], rot: 0, age: 0, life: 800 }] : []),
      ],
    });
  }
}
