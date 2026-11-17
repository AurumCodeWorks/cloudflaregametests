// Slot machines: the screen, the reels and the fairness panel. The server decides every spin; this
// file only draws it, and re-checks it with the same published code (fair.js, machines.js).
//
// Responsible design, on purpose (UK Gambling Commission RTS 8A, 13C, 14C-14F):
//   - no autoplay: one press, one spin; holding a key or the button down never starts another
//   - at least 2.5 seconds per spin, and nothing (no turbo, no quick-spin, no slam-stop) shortens it
//   - a return of the stake or less is shown plainly, with no win sound and no celebration
//   - time played and the session's net result are always on screen, next to a Stop button
import { CLIENT_SEED, newSeed, verifySpin } from "./fair.js";
import { celebrationTier, evaluate, exactRtp, formatMoney, MACHINES, MIN_SPIN_MS, reelSizes, STAKES } from "./machines.js";

const $ = (id) => document.getElementById(id);
const money = formatMoney; // amounts are play-money pence
const signed = (n) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(n)}` : "0p");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SUIT = { c: "♣", d: "♦", h: "♥", s: "♠" };
const cardText = (c) => `${c[0] === "T" ? "10" : c[0]}${SUIT[c[1]]}`;
const SYMBOL_NAMES = { 7: "Seven", B1: "Bar", B2: "Double bar", B3: "Triple bar", BELL: "Bell", PLUM: "Plum", ORANGE: "Orange", LEMON: "Lemon", CHERRY: "Cherry", BAR: "Any bar", ANY: "Any symbol" };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// How the reels move. Each machine has its own feel; none of this can change a result.
const MOTION = {
  classic: { cellMs: 26, firstStop: 1000, gap: 400, decel: 700 }, // lands at about 1.7 s, 2.1 s, 2.5 s
  cards: { cellMs: 45, firstStop: 900, gap: 300, decel: 700 }, // lands at about 1.6 s ... 2.8 s
};
const SOUNDS = { classic: "slot-classic", cards: "slot-royal" };

export function createSlots({ api, toast, cardEl, FX, Sound, show, app }) {
  const s = {
    machine: null, // the machine on screen
    state: null, // what the server last said: commit, nonce, session...
    stake: STAKES.includes(+localStorage.getItem("slot-stake-p")) ? +localStorage.getItem("slot-stake-p") : STAKES[0],
    spinning: false,
    stops: {}, // machine id -> the stops on show
    openedAt: 0,
    clockSkew: 0, // server time minus this device's time
    commits: {}, // seedNo -> fingerprint as first seen, before any spin was made with it
    expectedNext: {}, // seedNo -> the fingerprint promised for it by the previous seed's "next"
    verified: {}, // seedNo -> { ok, spins, problem }
    lastTier: "none",
  };
  const rtp = Object.fromEntries(Object.keys(MACHINES).map((id) => [id, exactRtp(id)]));
  window.__slots = s; // test hook

  // ---------------------------------------------------------------- lobby cards
  for (const id of Object.keys(MACHINES)) {
    const meta = document.querySelector(`[data-game-meta="${id}"]`);
    if (meta) meta.textContent = `${MACHINES[id].blurb} ${money(STAKES[0])} to ${money(STAKES.at(-1))} of play money a spin · returns ${(rtp[id].rtp * 100).toFixed(2)}%`;
    document.querySelector(`[data-game="${id}"] button`)?.addEventListener("click", () => open(id));
  }

  // ---------------------------------------------------------------- reels
  const symbolEl = (sym) => {
    const el = document.createElement("div");
    el.className = "sym";
    el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#f-${sym}"/></svg>`;
    el.setAttribute("aria-label", SYMBOL_NAMES[sym] ?? sym);
    return el;
  };
  const faceEl = (m, sym) => (m.kind === "cards" ? cardEl(sym) : symbolEl(sym));

  /** Build the reels: each strip is drawn three times over so it can scroll without a seam. */
  function buildReels() {
    const m = MACHINES[s.machine];
    const win = $("reel-window");
    win.replaceChildren();
    win.style.setProperty("--reels", m.reels.length);
    m.reels.forEach((strip, i) => {
      const reel = document.createElement("div");
      reel.className = "reel";
      const tape = document.createElement("div");
      tape.className = "tape";
      for (let copy = 0; copy < 3; copy++)
        strip.forEach((sym, k) => {
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.dataset.stop = k;
          cell.dataset.copy = copy;
          cell.append(faceEl(m, sym));
          tape.append(cell);
        });
      reel.append(tape);
      win.append(reel);
    });
    win.append(Object.assign(document.createElement("div"), { className: "payline" }));
    s.stops[s.machine] ??= m.reels.map(() => 0);
    placeReels();
  }
  const tapes = () => [...document.querySelectorAll("#reel-window .tape")];
  const cellPx = () => document.querySelector("#reel-window .cell")?.getBoundingClientRect().height || 100;
  /** The tape offset that puts stop `k` on the middle row (using the middle copy of the strip). */
  const restY = (len, k, cell) => -(len + k - 1) * cell;
  function placeReels() {
    const m = MACHINES[s.machine], cell = cellPx();
    tapes().forEach((tape, i) => {
      tape.getAnimations().forEach((a) => a.cancel());
      tape.style.transform = `translate3d(0, ${restY(m.reels[i].length, s.stops[s.machine][i], cell)}px, 0)`;
    });
  }
  addEventListener("resize", () => { if (s.machine && !s.spinning && !$("screen-slots").hidden) placeReels(); });

  function clearWin() {
    document.querySelectorAll("#reel-window .cell.win").forEach((c) => c.classList.remove("win"));
    $("cabinet").classList.remove("has-win", "tier-small", "tier-medium", "tier-big");
  }

  /**
   * Spin every reel, then bring each to rest on its stop, left to right. `result` resolves to the
   * server's stops; the reels keep turning until it arrives. Nothing the player does can shorten this.
   */
  async function animateSpin(result, startedAt) {
    const m = MACHINES[s.machine], mo = MOTION[m.kind], cell = cellPx(), kind = SOUNDS[m.kind];
    const list = tapes();
    const loops = list.map((tape, i) => {
      const len = m.reels[i].length;
      // one full turn of the strip, downwards, repeating: the picture at both ends is identical
      return tape.animate([{ transform: `translate3d(0, ${-2 * len * cell}px, 0)` }, { transform: `translate3d(0, ${-len * cell}px, 0)` }],
        { duration: len * mo.cellMs, iterations: Infinity, easing: "linear", delay: reduced ? 0 : i * 40 });
    });
    $("reel-window").classList.add("spinning");
    Sound.play(`${kind}-start`);
    const bed = Sound.loop?.(`${kind}-spin`, { volume: 0.8 });
    let stops;
    try { stops = await result; } catch (err) {
      bed?.();
      loops.forEach((a) => a.cancel());
      $("reel-window").classList.remove("spinning");
      placeReels();
      throw err;
    }
    // Stop times are counted from the press; a slow reply only ever makes them later, never earlier
    const late = Math.max(0, performance.now() - startedAt - (mo.firstStop - 200));
    const lands = list.map(async (tape, i) => {
      const len = m.reels[i].length, to = restY(len, stops[i], cell);
      const beginAt = startedAt + late + mo.firstStop + i * mo.gap;
      await wait(Math.max(0, beginAt - performance.now()));
      loops[i].cancel();
      // Slow down over a distance that matches the spinning speed, so there is no jerk as the reel is caught
      const dist = ((cell / mo.cellMs) * mo.decel) / 2;
      const a = tape.animate([{ transform: `translate3d(0, ${to - dist}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }],
        { duration: mo.decel, easing: "cubic-bezier(.25, .5, .4, 1)", fill: "forwards" });
      await a.finished;
      tape.style.transform = `translate3d(0, ${to}px, 0)`;
      a.cancel();
      Sound.play(`${kind}-stop`, { volume: 0.9 });
      if (!reduced) tape.animate([{ transform: `translate3d(0, ${to + cell * 0.05}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }], { duration: 160, easing: "ease-out" });
      if (i === list.length - 1) bed?.();
    });
    await Promise.all(lands);
    $("reel-window").classList.remove("spinning");
    s.stops[s.machine] = stops;
  }

  // ---------------------------------------------------------------- one spin
  async function sendSpin(rid) {
    const body = JSON.stringify({ machine: s.machine, stake: s.stake, rid });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/slots/spin", { method: "POST", body, headers: { "content-type": "application/json", authorization: `Bearer ${app.token}` } });
        const r = await res.json();
        if (r.ok) return r;
        if (res.status === 429 && attempt < 2) { await wait(Math.min(2600, (r.retryInMs ?? 500) + 50)); continue; } // another tab just spun
        throw Object.assign(new Error(r.error || "That spin couldn't be made."), { final: true });
      } catch (err) {
        if (err.final) throw err;
        lastErr = err; // network trouble: send the SAME press again; the server never makes it a second spin
        await wait(700);
      }
    }
    throw lastErr ?? new Error("Couldn't reach the server.");
  }

  async function spin() {
    if (s.spinning || !s.state?.clientSeed) return;
    const machine = s.machine, m = MACHINES[machine], stake = s.stake;
    s.spinning = true;
    renderControls();
    clearWin();
    setResult("", "");
    const startedAt = performance.now();
    const rid = newSeed();
    const reply = sendSpin(rid);
    try {
      await animateSpin(reply.then((r) => r.spin.stops), startedAt);
      const r = await reply;
      const spin = r.spin;
      applyState(r);
      // Check what the server said against the published paytable before showing it
      const check = evaluate(machine, spin.stops);
      const sizes = reelSizes(machine);
      const sane = spin.stops.length === sizes.length && spin.stops.every((x, i) => Number.isInteger(x) && x >= 0 && x < sizes[i]) && check.mult * spin.stake === spin.payout && spin.machine === machine && spin.stake === stake;
      const sameCommit = (s.commits[r.seedNo] ??= r.commit) === r.commit;
      if (!sane || !sameCommit) { s.verified[r.seedNo] = { ok: false, problem: sameCommit ? "A spin didn't match the published paytable." : "The seed fingerprint changed mid-way." }; renderFair(); }
      present(m, spin, check);
      app.onSlotBalance?.(r.balance);
    } catch (err) {
      toast(err.message || "That spin couldn't be made.");
      await refresh().catch(() => {});
    }
    // The next spin can start no sooner than 2.5 s after this one started (the server enforces it too)
    await wait(Math.max(0, MIN_SPIN_MS - (performance.now() - startedAt)));
    s.spinning = false;
    renderControls();
  }

  /** Show the result. Only a return above the stake is a win; anything else is stated plainly. */
  function present(m, spin, check) {
    const tier = celebrationTier(spin.stake, spin.payout);
    s.lastTier = tier;
    if (!spin.payout) return setResult("No win", "none");
    if (tier === "none") return setResult(`${check.label} · ${money(spin.payout)} returned`, "returned");
    const mid = MACHINES[s.machine].reels.map((strip, i) => document.querySelectorAll("#reel-window .reel")[i].querySelector(`.cell[data-copy="1"][data-stop="${spin.stops[i]}"]`));
    check.cells.forEach((i) => mid[i]?.classList.add("win"));
    $("cabinet").classList.add("has-win", `tier-${tier}`);
    setResult(`${check.label} · you win ${money(spin.payout)}`, "win");
    Sound.play(`${SOUNDS[m.kind]}-win-${tier}`);
    if (tier === "small") return;
    const anchor = $("slot-result");
    // Each machine celebrates in its own way, scaled to the win. Lucky Sevens pays out brass coins;
    // Royal Reels uses the celebration you have equipped from the shop (medium wins get its lighter form).
    if (m.kind === "classic") FX.coinBurst?.($("reel-window"), tier);
    else FX.celebrate(tier === "big" ? app.celebration : app.celebration === "glow" ? "glow" : "chipshower", anchor, spin.payout, { chipColors: FX.chipColors() });
  }
  function setResult(text, kind) {
    const el = $("slot-result");
    el.textContent = text;
    el.dataset.kind = kind;
  }

  // ---------------------------------------------------------------- controls and session
  $("stakes").append(...STAKES.map((v) => Object.assign(document.createElement("button"), { className: "stake-key", type: "button", textContent: money(v) })).map((b, i) => { b.dataset.stake = STAKES[i]; b.dataset.testid = `stake-${STAKES[i]}`; return b; }));
  $("slot-stakes-copy").textContent = `Stakes run from ${money(STAKES[0])} to ${money(STAKES.at(-1))} of play money a spin, and a win is always the paytable multiple of what you staked: the same line pays ten times as much on £1 as on 10p. 100 play chips are £1. Nothing here can be bought with, or exchanged for, real money.`;
  function renderControls() {
    const ready = !!s.state?.clientSeed && !s.spinning;
    $("spin-btn").disabled = !ready;
    $("spin-btn").textContent = s.spinning ? "Spinning…" : `Spin · ${money(s.stake)}`;
    document.querySelectorAll("#stakes [data-stake]").forEach((b) => {
      b.setAttribute("aria-pressed", String(+b.dataset.stake === s.stake));
      b.disabled = s.spinning;
    });
  }
  $("stakes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stake]");
    if (!b || s.spinning || !STAKES.includes(+b.dataset.stake)) return;
    s.stake = +b.dataset.stake;
    try { localStorage.setItem("slot-stake-p", String(s.stake)); } catch {}
    renderControls();
  });
  // One press, one spin. A key held down repeats "keydown": those repeats are ignored, so the key must be released first.
  $("spin-btn").addEventListener("keydown", (e) => { if (e.repeat) e.preventDefault(); });
  $("spin-btn").addEventListener("click", () => spin());

  function renderSession() {
    const sess = s.state?.session;
    const start = sess?.startedAt ? sess.startedAt - s.clockSkew : s.openedAt;
    const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
    $("sess-time").textContent = h ? `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
    const net = (sess?.returned ?? 0) - (sess?.staked ?? 0);
    $("sess-spins").textContent = (sess?.spins ?? 0).toLocaleString("en-GB");
    $("sess-staked").textContent = money(sess?.staked ?? 0);
    $("sess-returned").textContent = money(sess?.returned ?? 0);
    $("sess-net").textContent = signed(net);
    $("sess-net").dataset.sign = net > 0 ? "up" : net < 0 ? "down" : "even";
  }
  let clock = null;

  function applyState(st) {
    s.state = { seedNo: st.seedNo, commit: st.commit, nextCommit: st.nextCommit, clientSeed: st.clientSeed, nonce: st.nonce, session: st.session };
    s.clockSkew = st.now - Date.now();
    s.commits[st.seedNo] ??= st.commit; // remembered from before any spin, so it can't be swapped later
    s.expectedNext[st.seedNo + 1] ??= st.nextCommit;
    renderSession();
    renderFair();
  }
  async function refresh() {
    const st = await api("/api/slots");
    applyState(st);
    // First visit: give the server a random seed made by this browser (you can type your own in Fair play)
    if (!st.clientSeed) applyState(await api("/api/slots/seed", { method: "POST", body: JSON.stringify({ clientSeed: newSeed() }) }));
    renderControls();
  }

  async function open(id) {
    if (!MACHINES[id]) return;
    s.machine = id;
    s.openedAt = Date.now();
    const m = MACHINES[id];
    const screen = $("screen-slots");
    screen.dataset.machine = id;
    screen.dataset.kind = m.kind;
    $("slot-name").textContent = m.name;
    $("slot-blurb").textContent = m.blurb;
    $("slot-marquee").textContent = `${m.pays[0].label} pays ${m.pays[0].mult.toLocaleString("en-GB")}× · win line: middle row`;
    setResult("", "");
    show("slots");
    buildReels();
    clearWin();
    renderInfo();
    renderControls();
    Sound.setRoom?.(m.kind === "classic" ? "slots" : document.documentElement.dataset.room);
    clearInterval(clock);
    clock = setInterval(() => { if ($("screen-slots").hidden) { clearInterval(clock); clock = null; } else renderSession(); }, 1000);
    try { await refresh(); } catch (err) { toast(err.message); }
  }

  async function stop() {
    if (s.spinning) return toast("This spin is just finishing.");
    let ended = null;
    try { const r = await api("/api/slots/stop", { method: "POST" }); ended = r.ended; applyState(r); app.onSlotBalance?.(r.balance); } catch { /* leaving anyway */ }
    setDrawer(null);
    Sound.setRoom?.(document.documentElement.dataset.room);
    const start = ended?.startedAt ? ended.startedAt - s.clockSkew : s.openedAt;
    const mins = Math.max(1, Math.round((Date.now() - start) / 60000));
    const net = ended ? ended.returned - ended.staked : 0;
    $("sum-time").textContent = `${mins} minute${mins === 1 ? "" : "s"}`;
    $("sum-spins").textContent = (ended?.spins ?? 0).toLocaleString("en-GB");
    $("sum-staked").textContent = money(ended?.staked ?? 0);
    $("sum-returned").textContent = money(ended?.returned ?? 0);
    $("sum-net").textContent = signed(net);
    $("sum-net").dataset.sign = net > 0 ? "up" : net < 0 ? "down" : "even";
    $("slot-summary").hidden = false;
    $("sum-done").focus();
  }
  $("slot-stop").addEventListener("click", stop);
  $("sum-done").addEventListener("click", () => { $("slot-summary").hidden = true; app.backToLobby(); });

  // ---------------------------------------------------------------- paytable, odds and reel strips
  function renderInfo() {
    const m = MACHINES[s.machine], r = rtp[s.machine];
    const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
    const oneIn = (count) => `1 in ${Math.round(r.combos / count).toLocaleString("en-GB")}`;
    const show = (p) => m.kind === "cards"
      ? `<span class="pt-cards">${p.example.map((c) => `<i class="${"hd".includes(c[1]) ? "red" : ""}">${cardText(c)}</i>`).join("")}</span>`
      : `<span class="pt-syms">${p.show.map((x) => (x === "ANY" ? `<i class="any">any</i>` : `<svg viewBox="0 0 100 100" aria-label="${SYMBOL_NAMES[x]}"><use href="#f-${x}"/></svg>`)).join("")}</span>`;
    $("slot-paytable").innerHTML = m.pays.map((p) => `<div class="pt-row">${show(p)}<span class="pt-name">${p.label}<small>${oneIn(r.lines[p.key].count)}</small></span><strong>${p.mult}×</strong></div>`).join("");
    $("slot-odds").innerHTML = `
      <p><strong data-testid="rtp">Return to player: ${pct(r.rtp)}</strong>. Over a very long run this machine pays back ${pct(r.rtp)} of everything staked and keeps ${pct(1 - r.rtp)}. Your own session can be far above or below that.</p>
      <p>That figure is exact, not an estimate: your browser has just gone through all ${r.combos.toLocaleString("en-GB")} combinations of the reel stops below, which pay ${r.totalMult.toLocaleString("en-GB")} stakes in total (${r.totalMult.toLocaleString("en-GB")} ÷ ${r.combos.toLocaleString("en-GB")}).</p>
      <p>A spin wins more than its stake ${pct(r.winRate, 1)} of the time${r.anyReturn > r.winRate ? `, and returns just the stake a further ${pct(r.anyReturn - r.winRate, 1)} (that is not counted or celebrated as a win)` : ""}. The biggest win is ${r.maxMult.toLocaleString("en-GB")}× the stake.</p>
      <p>Wins are paid on the middle row only. Every stop on a reel is equally likely on every spin; nothing about earlier spins, your stake, your balance or your cosmetics changes the odds. Symbols just above or below the line are simply their neighbours on the strip.</p>`;
    $("slot-strips").innerHTML = m.reels.map((strip, i) => `<div class="strip"><span>Reel ${i + 1} · ${strip.length} stops</span><div>${strip.map((x) => (m.kind === "cards"
      ? `<i class="${"hd".includes(x[1]) ? "red" : ""}">${cardText(x)}</i>` : `<svg viewBox="0 0 100 100" aria-label="${SYMBOL_NAMES[x]}"><use href="#f-${x}"/></svg>`)).join("")}</div></div>`).join("");
  }

  // ---------------------------------------------------------------- provably fair panel
  const short = (h) => `<code title="${h}">${h.slice(0, 16)}…</code>`;
  function renderFair() {
    const st = s.state;
    if (!st) return;
    const v = s.verified[st.seedNo - 1], bad = s.verified[st.seedNo]?.ok === false ? s.verified[st.seedNo] : v?.ok === false ? v : null;
    const chip = $("slot-fair-btn");
    chip.dataset.state = bad ? "bad" : v?.ok ? "ok" : "locked";
    chip.querySelector("use").setAttribute("href", v?.ok && !bad ? "#i-shield" : "#i-lock");
    $("slot-fair-text").textContent = bad ? "Check failed" : v?.ok ? `Verified ${v.spins} spin${v.spins === 1 ? "" : "s"}` : "Seed locked";
    $("fair-commit").innerHTML = short(st.commit);
    $("fair-next").innerHTML = short(st.nextCommit);
    $("fair-nonce").textContent = st.nonce.toLocaleString("en-GB");
    if (document.activeElement !== $("fair-seed")) $("fair-seed").value = st.clientSeed ?? "";
    $("fair-rotate").textContent = st.nonce ? "Reveal the server seed and check my spins" : "Use this seed";
    const out = $("fair-result");
    if (bad) out.innerHTML = `<span class="bad">✖ ${bad.problem}</span>`;
    else if (v?.ok) out.innerHTML = `<span class="ok">✔ ${v.spins} spin${v.spins === 1 ? "" : "s"} re-played in your browser from the revealed seed. Every one matches, and the seed matches the fingerprint ${short(v.commit)} you were shown before the first of them.</span>`;
    else out.textContent = st.nonce ? "The server seed stays secret while it's in use. Reveal it whenever you like to check every spin made with it." : "No spins yet with this seed pair.";
  }

  /** Re-play every spin of a revealed seed pair and compare with what was shown and paid. */
  async function verifySeed(revealed) {
    const hist = await api(`/api/slots/history?seed=${revealed.seedNo}`);
    const commit = s.commits[revealed.seedNo] ?? revealed.commit; // the fingerprint seen before the spins, when we have it
    let problem = null;
    if (hist.spins.length !== revealed.spins) problem = "The spin history is incomplete.";
    for (const sp of hist.spins) {
      if (problem) break;
      const sizes = MACHINES[sp.machine] ? reelSizes(sp.machine) : null;
      const ok = sizes && (await verifySpin({ commit, serverSeed: revealed.serverSeed, clientSeed: revealed.clientSeed, nonce: sp.nonce, machine: sp.machine, sizes, stops: sp.stops }));
      if (!ok) problem = `Spin ${sp.nonce} does not match the revealed seed.`;
      else if (evaluate(sp.machine, sp.stops).mult * sp.stake !== sp.payout) problem = `Spin ${sp.nonce} was not paid as the paytable says.`;
    }
    s.verified[revealed.seedNo] = { ok: !problem, problem, spins: hist.spins.length, commit };
    return s.verified[revealed.seedNo];
  }

  $("fair-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (s.spinning) return toast("Wait for this spin to finish.");
    const typed = $("fair-seed").value.trim();
    // Revealing needs a new seed for the next pair: yours if you typed a different one, otherwise a fresh random one
    const clientSeed = typed && (typed !== s.state.clientSeed || !s.state.nonce) ? typed : newSeed();
    if (!CLIENT_SEED.test(clientSeed)) return toast("A seed is 1-64 letters, digits, - or _.");
    try {
      const before = s.state;
      const r = await api("/api/slots/seed", { method: "POST", body: JSON.stringify({ clientSeed }) });
      if (r.revealed) {
        // The seed that takes over must be the one whose fingerprint was promised beforehand
        if (r.commit !== before.nextCommit) s.verified[r.seedNo] = { ok: false, problem: "The new seed isn't the one that was promised." };
        applyState(r);
        $("fair-result").textContent = "Checking every spin…";
        await verifySeed(r.revealed);
        loadSeeds();
      } else applyState(r);
      $("fair-seed").value = r.clientSeed;
      renderFair();
      renderControls();
    } catch (err) { toast(err.message); }
  });

  async function loadSeeds() {
    try {
      const { seeds } = await api("/api/slots/seeds");
      $("fair-past").replaceChildren(...seeds.map((sd) => {
        const row = document.createElement("div");
        row.className = "seed-row";
        const v = s.verified[sd.seedNo];
        row.innerHTML = `<div><strong>Seed pair ${sd.seedNo}</strong> · ${sd.spins} spin${sd.spins === 1 ? "" : "s"}<br/><small>server seed <code>${sd.serverSeed}</code><br/>fingerprint <code>${sd.commit}</code><br/>your seed <code></code></small></div>
          <button class="btn btn-quiet btn-small" type="button">${v ? (v.ok ? "✔ Verified" : "✖ Failed") : "Verify"}</button>`;
        row.querySelector("small code:last-child").textContent = sd.clientSeed;
        row.querySelector("button").onclick = async (ev) => {
          ev.target.textContent = "Checking…";
          const res = await verifySeed(sd).catch(() => ({ ok: false }));
          ev.target.textContent = res.ok ? "✔ Verified" : "✖ Failed";
          renderFair();
        };
        return row;
      }));
      $("fair-past-h").hidden = !seeds.length;
    } catch { /* the list is a convenience */ }
  }

  // ---------------------------------------------------------------- drawer (paytable / fair play)
  function setDrawer(which) {
    $("slot-drawer").classList.toggle("open", !!which);
    $("slot-drawer").dataset.tab = which ?? "";
    $("screen-slots").classList.toggle("drawer-open", !!which); // on wide screens the machine moves aside for it
    document.querySelectorAll("[data-slot-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.slotTab === which)));
    if (which === "fair") loadSeeds();
  }
  $("slot-info-btn").addEventListener("click", () => setDrawer($("slot-drawer").dataset.tab === "info" ? null : "info"));
  $("slot-fair-btn").addEventListener("click", () => setDrawer($("slot-drawer").dataset.tab === "fair" ? null : "fair"));
  document.querySelectorAll("[data-slot-tab]").forEach((b) => b.addEventListener("click", () => setDrawer(b.dataset.slotTab)));
  $("slot-drawer-close").addEventListener("click", () => setDrawer(null));
  addEventListener("keydown", (e) => e.key === "Escape" && setDrawer(null));

  return { open, refresh, rtp, verifySeed, redraw: () => { if (s.machine && !$("screen-slots").hidden && !s.spinning) buildReels(); } };
}
