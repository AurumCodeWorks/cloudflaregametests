// Card Table client. Renders whatever the table server sends; the server is the only authority.
import * as FX from "./fx.js";
import { createShop } from "./shop.js";
const $ = (id) => document.getElementById(id);
const SUIT = { c: "♣", d: "♦", h: "♥", s: "♠" };
const RANK = { T: "10" };

const app = {
  token: localStorage.getItem("token"),
  user: null,
  ws: null,
  state: null,
  verified: {}, // handNo -> true/false
  demo: new URLSearchParams(location.search).get("demo"),
};
window.__poker = app; // test hook

// Card deck theme: ?deck=noir, or the player's saved choice
const DECKS = ["ivory", "noir", "deco", "casino", "royal", "modern"];
function setDeck(name) {
  if (!DECKS.includes(name)) name = "ivory";
  document.documentElement.dataset.deck = name;
  try { localStorage.setItem("deck", name); } catch {}
}
app.setDeck = setDeck;

// Room theme: ?room=riviera, or the player's saved choice
const ROOMS = ["classic", "midnight", "vegas", "riviera", "speakeasy", "penthouse"];
function setRoom(name) {
  if (!ROOMS.includes(name)) name = "classic";
  document.documentElement.dataset.room = name;
  try { localStorage.setItem("room", name); } catch {}
}
app.setRoom = setRoom;
setRoom(new URLSearchParams(location.search).get("room") || (() => { try { return localStorage.getItem("room"); } catch { return null; } })() || "classic");
setDeck(new URLSearchParams(location.search).get("deck") || (() => { try { return localStorage.getItem("deck"); } catch { return null; } })() || "ivory");

// Chip set and win celebration (same pattern: ?chips=gold&celebration=goldrush, or the saved choice)
const CHIP_SETS = Object.keys(FX.CHIP_STYLES);
const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
function setChips(name) {
  if (!CHIP_SETS.includes(name)) name = "casino";
  document.documentElement.dataset.chips = name;
  FX.setChipStyle(name);
  app.chips = name;
  try { localStorage.setItem("chips", name); } catch {}
}
function setCelebration(name) {
  if (!FX.CELEBRATIONS.includes(name)) name = "glow";
  app.celebration = name;
  try { localStorage.setItem("celebration", name); } catch {}
}
app.setChips = setChips;
app.setCelebration = setCelebration;
app.FX = FX;
setChips(new URLSearchParams(location.search).get("chips") || saved("chips") || "casino");
setCelebration(new URLSearchParams(location.search).get("celebration") || saved("celebration") || "glow");

// ---------------------------------------------------------------- screens
function show(screen) {
  for (const s of ["login", "lobby", "table"]) $(`screen-${s}`).hidden = s !== screen;
  for (const id of ["leave-btn", "fair-btn", "history-btn"]) $(id).hidden = screen !== "table";
  $("shop-btn").hidden = screen === "login" || !!app.demo;
  $("wallet-balance").parentElement.hidden = screen === "login";
  if (screen !== "table") $("drawer").classList.remove("open");
  if (screen !== "table") fanCards();
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------------------------------------------------------------- api
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(app.token ? { authorization: `Bearer ${app.token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
async function refreshMe() {
  app.user = await api("/api/me");
  $("wallet-balance").textContent = app.user.balance.toLocaleString();
  $("lobby-name").textContent = app.user.name;
  $("daily").hidden = app.user.balance >= 500;
}
$("daily-btn").addEventListener("click", async () => {
  try {
    await api("/api/daily", { method: "POST" });
    await refreshMe();
    toast("1,000 chips added. Good luck!");
  } catch (err) {
    toast(err.message);
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/login", { method: "POST", body: JSON.stringify({ name: $("name").value }) });
    app.token = r.token;
    localStorage.setItem("token", r.token);
    await refreshMe();
    await loadShop();
    show("lobby");
  } catch (err) {
    toast(err.message);
  }
});

$("play-btn").addEventListener("click", async () => {
  try {
    const { tableId } = await api("/api/play", { method: "POST" });
    connect(tableId);
  } catch (err) {
    toast(err.message);
  }
});

$("leave-btn").addEventListener("click", () => send({ type: "leave" }));
const openDrawer = () => $("drawer").classList.add("open");
$("fair-btn").addEventListener("click", openDrawer);
$("history-btn").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", () => $("drawer").classList.remove("open"));
addEventListener("keydown", (e) => e.key === "Escape" && $("drawer").classList.remove("open"));

// ---------------------------------------------------------------- websocket
function connect(tableId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/table/${tableId}?token=${encodeURIComponent(app.token)}`);
  app.ws = ws;
  app.tableId = tableId;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") onState(msg);
    else if (msg.type === "error") toast(msg.message);
    else if (msg.type === "stood") {
      // Back to the lobby straight away; don't wait for the socket's closing handshake
      toast(msg.amount > 0 ? `You left the table with ${msg.amount.toLocaleString()} chips` : "You're out of chips. Claim your daily chips to play again.");
      app.ws = null;
      ws.close();
      refreshMe().catch(() => {}).finally(() => show("lobby"));
    }
  };
  ws.onclose = async () => {
    if (app.ws !== ws) return;
    app.ws = null;
    await refreshMe().catch(() => {});
    show("lobby");
  };
  show("table");
}
function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------- provably fair check
async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function verifyHand(hand) {
  if (!hand.reveal || app.verified[hand.no] !== undefined) return;
  app.verified[hand.no] = "checking";
  const leaves = await Promise.all(hand.reveal.map((r) => (r.leaf ? r.leaf : sha256Hex(`${r.card}:${r.salt}`))));
  const ok = (await sha256Hex(leaves.join(","))) === hand.commit;
  // every card shown on the board must be one of the revealed (committed) cards
  const revealed = new Set(hand.reveal.filter((r) => r.card).map((r) => r.card));
  app.verified[hand.no] = ok && hand.board.every((c) => revealed.has(c));
  if (app.state?.hand?.no === hand.no) renderFair(app.state.hand);
}

// ---------------------------------------------------------------- rendering
const COURT = { J: "J", Q: "Q", K: "K" };
const pip = (suit, cls = "pip") => `<svg class="${cls}" viewBox="0 0 100 100"><use href="#s-${suit}"/></svg>`;

function cardEl(code, { small = false, win = false, deck = null } = {}) {
  const el = document.createElement("div");
  el.className = "card" + (small ? " small" : "") + (win ? " win" : "");
  el.dataset.deck = deck || document.documentElement.dataset.deck || "modern";
  if (!code) {
    el.classList.add("placeholder");
    return el;
  }
  if (code === "??") {
    el.classList.add("back");
    el.innerHTML = `<div class="back-field"></div><div class="crest">${pip("s", "crest-pip")}</div>`;
    return el;
  }
  const r = code[0];
  const suit = code[1];
  const rank = RANK[r] ?? r;
  el.classList.add("face", suit === "h" || suit === "d" ? "red" : "black", `s-${suit}`, `r-${r}`);
  let art;
  if (r === "A") {
    el.classList.add("ace");
    art = `<div class="ring"></div>${pip(suit, "pip big")}`;
  } else if (COURT[r]) {
    el.classList.add("court");
    art = `<div class="panel"><span class="mono">${COURT[r]}</span>${pip(suit, "pip mini")}</div>`;
  } else {
    art = pip(suit, "pip big");
  }
  el.innerHTML =
    `<div class="idx tl"><span class="r">${rank}</span>${pip(suit)}</div>` +
    `<div class="art">${art}</div>` +
    `<div class="idx br"><span class="r">${rank}</span>${pip(suit)}</div>`;
  el.dataset.card = code;
  el.setAttribute("aria-label", `${rank} of ${{ c: "clubs", d: "diamonds", h: "hearts", s: "spades" }[suit]}`);
  return el;
}

app.cardEl = cardEl;

function onState(s) {
  const old = app.state;
  app.state = s;
  // Your buy-in just moved from your balance to the table: refresh the header balance
  if (!app.demo && (old?.you?.seat ?? -1) < 0 && s.you.seat >= 0) refreshMe().catch(() => {});
  if (s.hand?.reveal) verifyHand(s.hand);
  const before = capture();
  render();
  const flights = syncPools(old, s);
  drawPools(s, flights);
  animateDiff(old, s, before, flights);
}

/** Positions of things that may animate away, taken before the table is rebuilt. */
function capture() {
  const snap = { holes: {}, chips: {}, dealer: null };
  document.querySelectorAll(".seat[data-abs]").forEach((el) => {
    snap.holes[+el.dataset.abs] = [...el.querySelectorAll(".hole .card")].map((c) => c.getBoundingClientRect());
  });
  document.querySelectorAll("[data-chip-id]").forEach((c) => (snap.chips[c.dataset.chipId] = c.getBoundingClientRect()));
  const d = document.querySelector(".dealer");
  if (d) snap.dealer = d.getBoundingClientRect();
  return snap;
}

// One chip size per device, used everywhere (betting circles, pot, flights), so chips never change size.
const phone = matchMedia("(max-width: 900px)");
const chipSize = () => (phone.matches ? 20 : 28);

// ---------------------------------------------------------------- chip pools
// Each betting circle and the pot hold real chips ({id, d}). Chips keep their id as they move
// player -> betting circle -> pot -> winner, so they fly to and land on the right stack.
const pools = { hand: null, bets: {}, pot: [] };
let nextChipId = 1;
const newChips = (amount) => FX.chipBreakdown(amount, 999).map((d) => ({ id: nextChipId++, d }));
const sumChips = (list) => list.reduce((a, c) => a + c.d, 0);

/** Update the chip model from the new state. Returns the flights to animate. */
function syncPools(old, s) {
  const h = s.hand;
  const flights = []; // { chip, from: "plate" | "chip", seat, to: "bet" | "pot" | "win", winner }
  if (!h) { pools.hand = null; pools.bets = {}; pools.pot = []; return flights; }
  if (pools.hand !== h.no) { pools.hand = h.no; pools.bets = {}; pools.pot = []; old = null; }

  s.seats.forEach((st, i) => {
    const pool = (pools.bets[i] ??= []);
    const os = old?.seats[i];
    const target = st?.bet ?? 0;
    // Chips this seat put in since the last state (uses `total` when the server sends it)
    const added = st && os && st.total !== undefined && os.total !== undefined ? st.total - os.total : Math.max(0, target - sumChips(pool));
    if (target === 0 && (pool.length || added > 0)) {
      // Round over: the chips in this seat's betting circle slide into the pot...
      for (const c of pool) { pools.pot.push(c); flights.push({ chip: c, from: "chip", to: "pot" }); }
      // ...plus any chips put in by the action that closed the round (e.g. the final call), straight from the seat
      if (st && os && st.total !== undefined && added > 0)
        for (const c of newChips(added)) { pools.pot.push(c); flights.push({ chip: c, from: "plate", seat: i, to: "pot" }); }
      pools.bets[i] = [];
    } else if (target > sumChips(pool)) {
      for (const c of newChips(target - sumChips(pool))) { pool.push(c); flights.push({ chip: c, from: "plate", seat: i, to: "bet" }); }
    } else if (target < sumChips(pool)) {
      pools.bets[i] = newChips(target); // out of sync (e.g. reconnect): redraw without animation
    }
  });

  if (h.result) {
    // Pot goes to the winner(s): hand chips out until each winner's share is covered
    const owed = h.result.payouts.map((x) => x);
    const all = [...pools.pot, ...Object.values(pools.bets).flat()].sort((a, b) => b.d - a.d);
    for (const c of all) {
      const w = owed.reduce((best, amt, i) => (amt > (owed[best] ?? -1) ? i : best), -1);
      if (w >= 0 && owed[w] > 0) { owed[w] -= c.d; flights.push({ chip: c, from: "chip", to: "win", winner: w }); }
      else flights.push({ chip: c, from: "chip", to: "house" }); // rake
    }
    pools.pot = [];
    pools.bets = {};
  } else {
    // Keep the pot model equal to what the server says has been collected
    const collected = h.pot - s.seats.reduce((a, st) => a + (st?.bet ?? 0), 0);
    const have = sumChips(pools.pot);
    if (collected > have) pools.pot.push(...newChips(collected - have));
    else if (collected < have) pools.pot = newChips(collected);
  }
  return flights;
}

/** Draw chips grouped by value into stacks (max 8 per stack). Chips about to land are hidden. */
function drawPool(container, chips, hidden, maxStacks) {
  const size = chipSize();
  const m = FX.chipMetrics(size);
  const byValue = [...chips].sort((a, b) => b.d - a.d || a.id - b.id);
  const stacks = [];
  for (const c of byValue) {
    const last = stacks[stacks.length - 1];
    if (last && last[0].d === c.d && last.length < 8) last.push(c);
    else stacks.push([c]);
  }
  while (stacks.length > maxStacks) stacks[stacks.length - 2].push(...stacks.pop()); // overflow piles onto the previous stack
  container.replaceChildren(
    ...stacks.map((st) => {
      const col = document.createElement("div");
      col.className = "stack-col";
      col.style.width = `${m.w}px`;
      col.style.height = `${m.h + (st.length - 1) * m.step}px`;
      st.forEach((c, k) => {
        const el = FX.chipEl(c.d, size);
        el.dataset.chipId = c.id;
        el.style.bottom = `${k * m.step}px`;
        if (hidden.has(c.id)) el.style.visibility = "hidden";
        col.append(el);
      });
      return col;
    }),
  );
}

function drawPools(s, flights) {
  const you = s.you.seat;
  const n = s.seats.length;
  const rel = (i) => (you >= 0 ? (i - you + n) % n : i);
  const hidden = new Set(flights.filter((f) => f.to === "bet" || f.to === "pot").map((f) => f.chip.id));
  for (let k = 0; k < n; k++) $(`zone-${k}`).classList.add("empty");
  s.seats.forEach((st, i) => {
    const z = $(`zone-${rel(i)}`);
    if (!st) return;
    // Every seated player keeps their betting circle; it dims once they fold
    z.classList.remove("empty");
    z.classList.toggle("folded", !!st.folded);
    drawPool(z.querySelector(".zone-chips"), pools.bets[i] ?? [], hidden, 3);
    z.querySelector(".zone-amt").textContent = st.bet > 0 ? st.bet.toLocaleString() : "";
  });
  drawPool($("pot-pile"), pools.pot, hidden, 6);
}

function animateDiff(old, s, before, flights) {
  const oh = old?.hand;
  const nh = s.hand;
  if (!nh) return;
  const seatEl = (i) => document.querySelector(`.seat[data-abs="${i}"]`);
  const plateRect = (i) => seatEl(i)?.querySelector(".plate")?.getBoundingClientRect();
  const boardRect = $("board").getBoundingClientRect();
  // Card backs in flight use the deck of the card they stand in for (yours, or that opponent's)
  const back = (el) => cardEl("??", { deck: el?.dataset?.deck });
  const seatBack = (i) => () => cardEl("??", { deck: i === s.you.seat ? null : s.seats[i]?.cosmetics?.deck });
  const newHand = !oh || oh.no !== nh.no;
  const size = chipSize();
  let dealTime = 0;

  if (before.dealer) FX.glideFrom(document.querySelector(".dealer"), before.dealer);

  if (newHand) {
    // Deal two rounds, clockwise from the left of the button
    const order = [];
    for (let k = 1; k <= s.seats.length; k++) {
      const i = (nh.button + k) % s.seats.length;
      if (s.seats[i]?.inHand) order.push(i);
    }
    const targets = [];
    for (let round = 0; round < 2; round++)
      for (const i of order) {
        const c = seatEl(i)?.querySelectorAll(".hole .card")[round];
        if (c) targets.push({ el: c });
      }
    FX.deal(targets, boardRect, back);
    dealTime = targets.length * 150 + 450;
  } else {
    s.seats.forEach((st, i) => {
      const os = old.seats[i];
      if (!st || !os) return;
      if (!os.folded && st.folded && before.holes[i]?.length) FX.muck(before.holes[i], boardRect, seatBack(i));
      const els = seatEl(i)?.querySelectorAll(".hole .card") ?? [];
      st.hole.forEach((c, k) => {
        if (c !== "??" && os.hole[k] === "??" && els[k]) FX.flipIn(els[k], back, 400 + k * 180);
      });
    });
    if (oh.pot !== nh.pot) FX.tick($("pot"), oh.pot, nh.pot);
  }

  // Chips: each one flies on its own and lands on its stack, one after another
  const perSource = {};
  let sweepTime = 0;
  const showdownPause = nh.result && !oh?.result ? (nh.result.endedBy === "showdown" ? 1100 : 400) : 0;
  for (const f of flights) {
    const key = f.from === "plate" ? `p${f.seat}` : f.to;
    const k = (perSource[key] = (perSource[key] ?? -1) + 1);
    const target = document.querySelector(`[data-chip-id="${f.chip.id}"]`);
    if (f.to === "bet" || f.to === "pot") {
      const from = f.from === "plate" ? plateRect(f.seat) : before.chips[f.chip.id];
      const delay = dealTime + k * 110;
      if (f.to === "pot") sweepTime = Math.max(sweepTime, delay + 700);
      FX.landChip(f.chip.d, size, from, target, delay);
    } else if (f.to === "win" || f.to === "house") {
      const from = before.chips[f.chip.id];
      const dest = f.to === "win" ? plateRect(f.winner) : new DOMRect(innerWidth / 2, -60, 1, 1);
      const delay = showdownPause + k * 45;
      FX.landChip(f.chip.d, size, from, null, delay, { fadeOut: true, to: dest });
      if (f.to === "house") continue;
    }
  }

  // New board cards flip once any chips have been swept into the pot
  if (!newHand)
    nh.board.forEach((c, idx) => {
      if (idx >= oh.board.length) FX.flipIn($("board").children[idx], back, sweepTime + (idx - oh.board.length) * 220);
    });

  // Hand over: the celebration starts as the pot arrives
  if (nh.result && !oh?.result) {
    const you = s.you.seat;
    nh.result.payouts.forEach((amt, i) => {
      if (amt <= 0) return;
      const plate = () => seatEl(i)?.querySelector(".plate");
      const style = i === you ? app.celebration : (s.seats[i]?.cosmetics?.celebration ?? "glow");
      setTimeout(() => plate() && FX.celebrate(style, plate(), amt, { chipColors: FX.chipColors() }), showdownPause + 700);
    });
  }
}

function render() {
  const s = app.state;
  if (!s) return;
  const h = s.hand;
  const you = s.you.seat;
  const nSeats = s.seats.length;
  const rel = (i) => (you >= 0 ? (i - you + nSeats) % nSeats : i);
  const winners = new Set(h?.result ? h.result.pots.flatMap((p) => p.winners) : []);

  // board and pot label (chips are drawn by drawPools)
  $("pot").textContent = (h?.pot ?? 0).toLocaleString();
  const board = $("board");
  board.replaceChildren(...[0, 1, 2, 3, 4].map((i) => cardEl(h?.board[i])));
  $("street").textContent = h ? (h.result ? (h.result.endedBy === "showdown" ? "Showdown" : "Hand over") : h.street) : "Waiting for players";

  // seats
  s.seats.forEach((seat, i) => {
    const el = $(`seat-${rel(i)}`);
    el.className = `seat pos-${rel(i)}`;
    el.dataset.abs = i;
    if (!seat) {
      el.classList.add("empty");
      el.innerHTML = `<div class="hole"></div><div class="plate"><div class="name"><span class="nm">Open seat</span></div></div>`;
      return;
    }
    if (h && h.toAct === i && !h.result) el.classList.add("turn", ...(seat.isBot || !h.deadline ? ["bot-turn"] : []));
    if (seat.folded) el.classList.add("folded");
    if (winners.has(i)) el.classList.add("winner");

    const hole = document.createElement("div");
    hole.className = "hole";
    // Your cards use your deck; everyone else's cards show in the deck they've equipped
    for (const c of seat.hole) hole.append(cardEl(c, { small: true, deck: i === you ? null : seat.cosmetics?.deck }));

    const plate = document.createElement("div");
    plate.className = "plate";
    const badge = seat.isBot ? `<span class="tag-bot">BOT</span>` : seat.you ? `<span class="tag-you">YOU</span>` : "";
    const display = seat.isBot ? seat.name.replace(/\s*\(bot\)\s*$/i, "") : seat.name;
    let status = "";
    if (h?.result && winners.has(i)) {
      const shown = h.result.shown[i];
      status = `<div class="status win">Wins ${h.result.payouts[i].toLocaleString()}${shown ? ` · ${shown.hand}` : ""}</div>`;
    } else if (h?.result?.shown[i]) status = `<div class="status">${h.result.shown[i].hand}</div>`;
    else if (seat.allIn) status = `<div class="status allin">ALL IN</div>`;
    else if (seat.folded) status = `<div class="status">Folded</div>`;
    else if (!seat.connected) status = `<div class="status">Disconnected</div>`;
    else if (h && h.toAct === i && !h.result) status = `<div class="status">${seat.you ? "Your turn" : "Thinking…"}</div>`;
    plate.innerHTML =
      `<div class="avatar" style="--av:${avatarTone(seat.name)}">${escapeHtml(display.trim()[0]?.toUpperCase() ?? "?")}</div>` +
      `<div class="info"><div class="name"><span class="nm">${escapeHtml(display)}</span>${badge}</div><div class="stack">${seat.stack.toLocaleString()}</div>${status}</div>` +
      (h && h.button === i ? `<div class="dealer">D</div>` : "");

    el.replaceChildren(hole, plate);
  });

  renderActions(s);
  renderFair(h);
  $("log").replaceChildren(...s.log.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
  $("log").scrollTop = 1e9;
  if (s.wallet !== undefined) $("wallet-balance").textContent = s.wallet.toLocaleString();
}

function renderActions(s) {
  const h = s.hand;
  const L = s.legal;
  const myTurn = !!L;
  $("actions").classList.toggle("idle", !myTurn);
  const status = $("action-status");
  if (s.you.waiting) status.innerHTML = `You'll be dealt in at the start of the next hand.`;
  else if (myTurn) status.innerHTML = `<strong>Your turn.</strong> ${L.call ? `${L.call.toLocaleString()} to call.` : "No bet to you."}`;
  else if (h && !h.result) status.innerHTML = `Waiting for <strong>${escapeHtml(s.seats[h.toAct]?.name ?? "")}</strong>…`;
  else status.textContent = "Next hand starting soon…";

  $("btn-fold").disabled = !myTurn;
  $("btn-check").hidden = myTurn && !L.check;
  $("btn-call").hidden = !myTurn || L.check;
  $("btn-check").disabled = !myTurn;
  $("btn-call").textContent = myTurn && L.call ? `Call ${L.call.toLocaleString()}` : "Call";

  const canRaise = myTurn && L.canRaise;
  for (const el of [$("btn-raise"), $("raise-amount"), $("raise-slider"), ...document.querySelectorAll("[data-preset]")]) el.disabled = !canRaise;
  if (canRaise) {
    const slider = $("raise-slider");
    slider.min = L.minRaiseTo;
    slider.max = L.maxRaiseTo;
    slider.step = 5;
    if (!app.raiseTouched || +$("raise-amount").value < L.minRaiseTo || +$("raise-amount").value > L.maxRaiseTo) {
      slider.value = L.minRaiseTo;
      $("raise-amount").value = L.minRaiseTo;
    }
    const v = +$("raise-amount").value;
    $("btn-raise").textContent = v >= L.maxRaiseTo ? "All in" : `Raise to ${v.toLocaleString()}`;
    slider.style.setProperty("--fill", `${((v - L.minRaiseTo) / Math.max(1, L.maxRaiseTo - L.minRaiseTo)) * 100}%`);
  }

  // turn timer
  const fill = $("timer-fill");
  if (h?.deadline && myTurn) {
    const left = Math.max(0, h.deadline - Date.now());
    fill.style.width = `${Math.min(100, (left / (s.turnSeconds * 1000)) * 100)}%`;
  } else fill.style.width = "0";
}

function renderFair(h) {
  const body = $("fair-body");
  if (!h) return;
  const v = app.verified[h.no];
  const chip = $("fair-btn");
  chip.dataset.state = !h.result ? "locked" : v === true ? "ok" : v === false ? "bad" : "locked";
  chip.querySelector("use").setAttribute("href", !h.result || v === "checking" ? "#i-lock" : "#i-shield");
  $("fair-chip-text").textContent = !h.result ? "Deck locked" : v === true ? "Verified" : v === false ? "Check failed" : "Checking";
  const short = `<code>${h.commit.slice(0, 16)}…</code>`;
  if (!h.result) body.innerHTML = `Hand #${h.no} deck locked before dealing.<br/>Fingerprint ${short}`;
  else if (v === true) body.innerHTML = `Hand #${h.no}: <span class="ok">✔ Shuffle verified</span><br/>Every card you saw matches fingerprint ${short}, which was published before the deal. Folded hands stay private.`;
  else if (v === false) body.innerHTML = `Hand #${h.no}: <span class="bad">✖ Verification failed</span><br/>Fingerprint ${short}`;
  else body.innerHTML = `Hand #${h.no}: checking shuffle…`;
}

// Deep jewel tones for monogram avatars, picked from the name so each player keeps their colour
const TONES = ["#7a2e3a", "#2e5a4a", "#2f3f6e", "#6b4a2a", "#4a3566", "#2f5f6a", "#5a5a2e", "#6a2f52"];
function avatarTone(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/** Welcome screens: a fanned hand of the real cards in the player's chosen deck. */
function fanCards() {
  for (const art of document.querySelectorAll(".hero-art")) {
    if (art.children.length) continue;
    ["As", "Kh", "Qd", "Jc", "Ts"].forEach((c, i) => {
      const el = cardEl(c, { deck: app.user ? null : "ivory" });
      el.style.transform = `rotate(${(i - 2) * 11}deg)`;
      art.append(el);
    });
  }
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- action buttons
// Only send an action while it's actually your turn (a click can land just as the hand ends)
const myTurn = () => !!app.state?.legal;
$("btn-fold").onclick = () => myTurn() && send({ type: "action", action: "fold" });
$("btn-check").onclick = () => myTurn() && send({ type: "action", action: "check" });
$("btn-call").onclick = () => myTurn() && send({ type: "action", action: "call" });
$("btn-raise").onclick = () => {
  const L = app.state?.legal;
  if (!L) return;
  const to = Math.round(+$("raise-amount").value);
  app.raiseTouched = false;
  send(L && to >= L.maxRaiseTo ? { type: "action", action: "allin" } : { type: "action", action: "raise", to });
};
$("raise-slider").oninput = (e) => {
  app.raiseTouched = true;
  $("raise-amount").value = e.target.value;
  renderActions(app.state);
};
$("raise-amount").oninput = () => {
  app.raiseTouched = true;
  renderActions(app.state);
};
document.querySelectorAll("[data-preset]").forEach((b) => {
  b.onclick = () => {
    const s = app.state;
    const L = s?.legal;
    if (!L) return;
    const pot = s.hand.pot;
    const target = { half: s.hand.currentBet + pot / 2, pot: s.hand.currentBet + pot, max: L.maxRaiseTo }[b.dataset.preset];
    const v = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(target / 5) * 5));
    app.raiseTouched = true;
    $("raise-amount").value = v;
    $("raise-slider").value = v;
    renderActions(app.state);
  };
});
setInterval(() => {
  const s = app.state;
  if (!s?.hand?.deadline) return;
  renderActions(s);
  const ring = document.querySelector(".seat.turn .plate");
  if (ring) ring.style.setProperty("--t", Math.max(0, (s.hand.deadline - Date.now()) / (s.turnSeconds * 1000)).toFixed(3));
}, 200);

// ---------------------------------------------------------------- cosmetics shop
const shop = createShop({ api, toast, cardEl, FX, onEquip: applyEquipped });
app.shop = shop;
$("shop-btn").addEventListener("click", () => shop.open());
$("lobby-shop").addEventListener("click", () => shop.open());

/** Apply what the server says you have equipped, everywhere it shows. */
function applyEquipped(eq) {
  const v = (id) => id.split(":")[1];
  setDeck(v(eq.deck));
  setRoom(v(eq.room));
  setChips(v(eq.chips));
  setCelebration(v(eq.celebration));
  document.querySelectorAll(".hero-art").forEach((a) => a.replaceChildren());
  if (!$("screen-table").hidden) {
    send({ type: "cosmetics" }); // so the table shows your new card backs/celebration to everyone
    if (app.state) { render(); drawPools(app.state, []); }
  } else fanCards();
}
async function loadShop() {
  try {
    await shop.load();
    applyEquipped(shop.state.equipped);
  } catch (err) {
    console.error("shop", err);
  }
}

// ---------------------------------------------------------------- showroom (demo mode)
let demoTimers = [];
async function playDemo(demo) {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  app.state = null;
  pools.hand = null;
  let t = 0;
  for (const step of await demo.demoSequence()) {
    t += step.wait;
    demoTimers.push(setTimeout(() => onState(step.state), t));
  }
  app.demoLength = t;
  if (new URLSearchParams(location.search).get("loop") !== "0") demoTimers.push(setTimeout(() => playDemo(demo), t + 6500));
}

function showroom(demo) {
  const opts = (list, cur, names = {}) => list.map((v) => `<option value="${v}"${v === cur ? " selected" : ""}>${names[v] ?? v[0].toUpperCase() + v.slice(1)}</option>`).join("");
  const panel = document.createElement("div");
  panel.className = "showroom";
  panel.innerHTML = `<h3>Showroom <small>live, rendered on your device</small></h3>
    <label>Room<select data-k="room">${opts(ROOMS, document.documentElement.dataset.room)}</select></label>
    <label>Card deck<select data-k="deck">${opts(DECKS, document.documentElement.dataset.deck, { ivory: "Ivory & Gold", royal: "Royal Four-Colour", casino: "Casino Pro", deco: "Art Deco" })}</select></label>
    <label>Chips<select data-k="chips">${opts(CHIP_SETS, app.chips, Object.fromEntries(CHIP_SETS.map((k) => [k, FX.CHIP_STYLES[k].name])))}</select></label>
    <label>Celebration<select data-k="celebration">${opts(FX.CELEBRATIONS, app.celebration, { chipshower: "Chip Shower", goldrush: "Gold Rush" })}</select></label>
    <div class="row"><button class="primary" data-act="replay">Replay hand</button><button class="neutral" data-act="celebrate">Celebrate</button></div>`;
  document.querySelector(".topbar").after(panel);
  document.documentElement.classList.add("has-showroom");
  panel.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    const v = e.target.value;
    if (k === "room") setRoom(v);
    if (k === "deck") { setDeck(v); if (app.state) { render(); drawPools(app.state, []); } }
    if (k === "chips") { setChips(v); if (app.state) drawPools(app.state, []); }
    if (k === "celebration") setCelebration(v);
  });
  panel.addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (act === "replay") playDemo(demo);
    if (act === "celebrate") {
      const plate = document.querySelector('.seat[data-abs="0"] .plate');
      if (plate) FX.celebrate(app.celebration, plate, 390, { chipColors: FX.chipColors() });
    }
  });
}

// ---------------------------------------------------------------- start
async function start() {
  if (app.demo) {
    const demo = await import("./demo.js");
    show("table");
    $("wallet-balance").textContent = "500";
    if (app.demo === "play" || app.demo === "showroom") {
      // A scripted hand, played live by the real renderer (looping), with controls to try every cosmetic
      showroom(demo);
      playDemo(demo);
    } else if (app.demo === "celebrate") {
      // Plays every win celebration in turn on the showdown screen
      onState(await demo.demoState("showdown"));
      const names = { glow: "1 · Glow (free)", chipshower: "2 · Chip Shower", confetti: "3 · Confetti", spotlight: "4 · Spotlight", fireworks: "5 · Fireworks", goldrush: "6 · Gold Rush (flagship)" };
      const label = Object.assign(document.createElement("div"), { style: "position:fixed;top:78px;left:24px;z-index:70;font:800 22px Inter;color:#fff;background:rgba(0,0,0,.6);padding:8px 16px;border-radius:12px" });
      document.body.append(label);
      const plate = () => document.querySelector('.seat[data-abs="0"] .plate');
      for (const [i, name] of FX.CELEBRATIONS.entries()) {
        setTimeout(() => { label.textContent = names[name]; FX.celebrate(name, plate(), 390, { chipColors: FX.chipColors() }); }, 600 + i * 4200);
      }
    } else onState(await demo.demoState(app.demo));
    return;
  }
  if (app.token) {
    try {
      await refreshMe();
      await loadShop();
      show("lobby");
      return;
    } catch {
      localStorage.removeItem("token");
      app.token = null;
    }
  }
  show("login");
}
start();
