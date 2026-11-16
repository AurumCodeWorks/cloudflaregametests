// Card Table client. Renders whatever the table server sends; the server is the only authority.
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
  render();
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
  app.state = s;
  if (s.hand?.reveal) verifyHand(s.hand);
  render();
}

function render() {
  const s = app.state;
  if (!s) return;
  const h = s.hand;
  const you = s.you.seat;
  const nSeats = s.seats.length;
  const rel = (i) => (you >= 0 ? (i - you + nSeats) % nSeats : i);
  const winners = new Set(h?.result ? h.result.pots.flatMap((p) => p.winners) : []);

  // board and pot
  $("pot").textContent = (h?.pot ?? 0).toLocaleString();
  const board = $("board");
  board.replaceChildren(...[0, 1, 2, 3, 4].map((i) => cardEl(h?.board[i])));
  $("street").textContent = h ? (h.result ? (h.result.endedBy === "showdown" ? "Showdown" : "Hand over") : h.street) : "Waiting for players";

  // seats
  s.seats.forEach((seat, i) => {
    const el = $(`seat-${rel(i)}`);
    el.className = `seat pos-${rel(i)}`;
    if (!seat) {
      el.classList.add("empty");
      el.innerHTML = `<div class="hole"></div><div class="plate"><div class="name">Empty seat</div></div>`;
      return;
    }
    if (h && h.toAct === i && !h.result) el.classList.add("turn");
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
      bet.innerHTML = `<span class="chip"></span>${seat.bet.toLocaleString()}`;
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
  render();
};
$("raise-amount").oninput = () => {
  app.raiseTouched = true;
  render();
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
    render();
  };
});
setInterval(() => app.state?.hand?.deadline && renderActions(app.state), 250);

// ---------------------------------------------------------------- start
async function start() {
  if (app.demo) {
    const { demoState } = await import("./demo.js");
    show("table");
    $("wallet-balance").textContent = "500";
    onState(await demoState(app.demo));
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
