// Card Table client. Renders whatever the table server sends; the server is the only authority.
import * as FX from "./fx.js";
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
  $("leave-btn").hidden = screen !== "table";
  $("wallet-balance").parentElement.hidden = screen === "login";
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
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/login", { method: "POST", body: JSON.stringify({ name: $("name").value }) });
    app.token = r.token;
    localStorage.setItem("token", r.token);
    await refreshMe();
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
      toast(`You left the table with ${msg.amount.toLocaleString()} chips`);
      app.leftTable = true;
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

function cardEl(code, { small = false, win = false } = {}) {
  const el = document.createElement("div");
  el.className = "card" + (small ? " small" : "") + (win ? " win" : "");
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
  if (s.hand?.reveal) verifyHand(s.hand);
  const before = capture();
  render();
  animateDiff(old, s, before);
}

/** Positions of things that may animate away, taken before the table is rebuilt. */
function capture() {
  const snap = { holes: {}, bets: {}, dealer: null };
  document.querySelectorAll(".seat[data-abs]").forEach((el) => {
    const i = +el.dataset.abs;
    snap.holes[i] = [...el.querySelectorAll(".hole .card")].map((c) => c.getBoundingClientRect());
    const b = el.querySelector(".bet");
    if (b) snap.bets[i] = b.getBoundingClientRect();
  });
  const d = document.querySelector(".dealer");
  if (d) snap.dealer = d.getBoundingClientRect();
  return snap;
}

function hideUntil(el, promise) {
  if (!el) return;
  el.style.visibility = "hidden";
  promise.then(() => (el.style.visibility = ""));
}

function animateDiff(old, s, before) {
  const oh = old?.hand;
  const nh = s.hand;
  if (!nh) return;
  const seatEl = (i) => document.querySelector(`.seat[data-abs="${i}"]`);
  const plateRect = (i) => seatEl(i)?.querySelector(".plate")?.getBoundingClientRect();
  // Chips going to/from the pot use the pile's slot above the label, never the label itself
  const pileRect = $("pot-pile").getBoundingClientRect();
  const potRect = new DOMRect(pileRect.left + pileRect.width / 2 - 16, pileRect.bottom - 34, 32, 32);
  const boardRect = $("board").getBoundingClientRect();
  const back = () => cardEl("??");
  const newHand = !oh || oh.no !== nh.no;

  if (before.dealer) FX.glideFrom(document.querySelector(".dealer"), before.dealer);

  if (newHand) {
    // Deal two rounds, clockwise from the left of the button
    const n = s.seats.length;
    const order = [];
    for (let k = 1; k <= n; k++) {
      const i = (nh.button + k) % n;
      if (s.seats[i]?.inHand) order.push(i);
    }
    const targets = [];
    for (let round = 0; round < 2; round++)
      for (const i of order) {
        const c = seatEl(i)?.querySelectorAll(".hole .card")[round];
        if (c) targets.push({ el: c });
      }
    FX.deal(targets, boardRect, back);
    // Blinds slide out after the deal
    s.seats.forEach((st, i) => {
      if (!st?.bet) return;
      const betEl = seatEl(i).querySelector(".bet");
      hideUntil(betEl, FX.flyChips(st.bet, plateRect(i), betEl.getBoundingClientRect(), { delay: targets.length * 85 + 250 }));
    });
    return;
  }

  // New board cards flip over (after any bets are swept in)
  const swept = s.seats.some((st, i) => st && old.seats[i]?.bet > 0 && st.bet === 0);
  nh.board.forEach((c, idx) => {
    if (idx >= oh.board.length) FX.flipIn($("board").children[idx], back, (swept ? 450 : 0) + (idx - oh.board.length) * 160);
  });

  s.seats.forEach((st, i) => {
    const os = old.seats[i];
    if (!st || !os) return;
    if (!os.folded && st.folded && before.holes[i]?.length) FX.muck(before.holes[i], boardRect, back);
    const els = seatEl(i)?.querySelectorAll(".hole .card") ?? [];
    st.hole.forEach((c, k) => {
      if (c !== "??" && os.hole[k] === "??" && els[k]) FX.flipIn(els[k], back, 300 + k * 140);
    });
    if (st.bet > os.bet) {
      const betEl = seatEl(i).querySelector(".bet");
      if (betEl) hideUntil(betEl, FX.flyChips(st.bet - os.bet, plateRect(i), betEl.getBoundingClientRect()));
    } else if (os.bet > 0 && st.bet === 0 && before.bets[i]) {
      FX.flyChips(os.bet, before.bets[i], potRect);
    }
  });

  if (oh.pot !== nh.pot) FX.tick($("pot"), oh.pot, nh.pot);

  // Hand over: pot slides to the winner(s), then the celebration
  if (!oh.result && nh.result) {
    const delay = nh.result.endedBy === "showdown" ? 900 : 300;
    const you = s.you.seat;
    nh.result.payouts.forEach((amt, i) => {
      if (amt <= 0) return;
      setTimeout(() => FX.flyChips(amt, potRect, plateRect(i), { size: 32 }), delay);
      const plate = () => seatEl(i)?.querySelector(".plate");
      const style = i === you ? app.celebration : "glow";
      setTimeout(() => plate() && FX.celebrate(style, plate(), amt, { chipColors: FX.chipColors() }), delay + 500);
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

  // board and pot (the pile shows chips already collected, not the bets still in front of players)
  $("pot").textContent = (h?.pot ?? 0).toLocaleString();
  const collected = h && !h.result ? h.pot - s.seats.reduce((a, st) => a + (st?.bet ?? 0), 0) : 0;
  $("pot-pile").replaceChildren(...(collected > 0 ? FX.chipPile(collected, 30).children : []));
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
      el.innerHTML = `<div class="hole"></div><div class="plate"><div class="name">Empty seat</div></div>`;
      return;
    }
    if (h && h.toAct === i && !h.result) el.classList.add("turn", ...(seat.isBot || !h.deadline ? ["bot-turn"] : []));
    if (seat.folded) el.classList.add("folded");
    if (winners.has(i)) el.classList.add("winner");

    const hole = document.createElement("div");
    hole.className = "hole";
    for (const c of seat.hole) hole.append(cardEl(c, { small: true }));

    const plate = document.createElement("div");
    plate.className = "plate";
    const badge = seat.isBot ? `<span class="badge bot">BOT</span>` : seat.you ? `<span class="badge you">YOU</span>` : "";
    let status = "";
    if (h?.result && winners.has(i)) {
      const shown = h.result.shown[i];
      status = `<div class="status win">Wins ${h.result.payouts[i].toLocaleString()}${shown ? ` · ${shown.hand}` : ""}</div>`;
    } else if (h?.result?.shown[i]) status = `<div class="status">${h.result.shown[i].hand}</div>`;
    else if (seat.allIn) status = `<div class="status allin">ALL IN</div>`;
    else if (seat.folded) status = `<div class="status">Folded</div>`;
    else if (!seat.connected) status = `<div class="status">Disconnected</div>`;
    else if (h && h.toAct === i && !h.result) status = `<div class="status">Thinking…</div>`;
    plate.innerHTML =
      `<div class="name">${escapeHtml(seat.name)}${badge}</div><div class="stack">${seat.stack.toLocaleString()}</div>${status}` +
      (h && h.button === i ? `<div class="dealer">D</div>` : "");

    el.replaceChildren(hole, plate);
    if (seat.bet > 0) {
      const bet = document.createElement("div");
      bet.className = "bet";
      bet.append(FX.chipStack(seat.bet, 28), Object.assign(document.createElement("span"), { textContent: seat.bet.toLocaleString() }));
      el.append(bet);
    }
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
    $("btn-raise").textContent = +$("raise-amount").value >= L.maxRaiseTo ? "All in" : `Raise to ${(+$("raise-amount").value).toLocaleString()}`;
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
  const short = `<code>${h.commit.slice(0, 16)}…</code>`;
  if (!h.result) body.innerHTML = `Hand #${h.no} deck locked before dealing.<br/>Fingerprint ${short}`;
  else if (v === true) body.innerHTML = `Hand #${h.no}: <span class="ok">✔ Shuffle verified</span><br/>Every card you saw matches fingerprint ${short}, which was published before the deal. Folded hands stay private.`;
  else if (v === false) body.innerHTML = `Hand #${h.no}: <span class="bad">✖ Verification failed</span><br/>Fingerprint ${short}`;
  else body.innerHTML = `Hand #${h.no}: checking shuffle…`;
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- action buttons
$("btn-fold").onclick = () => send({ type: "action", action: "fold" });
$("btn-check").onclick = () => send({ type: "action", action: "check" });
$("btn-call").onclick = () => send({ type: "action", action: "call" });
$("btn-raise").onclick = () => {
  const L = app.state?.legal;
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

// ---------------------------------------------------------------- start
async function start() {
  if (app.demo) {
    const demo = await import("./demo.js");
    show("table");
    $("wallet-balance").textContent = "500";
    if (app.demo === "play") {
      // A scripted hand, played with the real renderer and animations
      let t = 0;
      for (const step of await demo.demoSequence()) {
        t += step.wait;
        setTimeout(() => onState(step.state), t);
      }
      app.demoLength = t;
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
