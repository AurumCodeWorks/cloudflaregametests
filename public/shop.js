// Cosmetics shop: browse, preview, buy and equip. The server owns prices and ownership.
export function createShop({ api, toast, cardEl, FX, onEquip }) {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let tab = "deck";
  const money = (p) => `£${(p / 100).toFixed(2)}`;
  const val = (id) => id.split(":")[1];
  const byId = (id) => state.catalog.find((i) => i.id === id);
  const owns = (id) => state.owned.includes(id);
  const NOTES = {
    deck: "Your card backs are what everyone else at the table sees.",
    room: "Rooms change the table and its surroundings for you.",
    chips: "Chip sets change how every bet and pot looks for you.",
    celebration: "Everyone at the table sees your celebration when you win a pot.",
    bundle: "Matching sets for less than buying each piece.",
  };

  async function load() {
    state = await api("/api/shop");
    return state;
  }

  function preview(item) {
    const box = document.createElement("div");
    box.className = "item-preview";
    if (item.type === "deck") {
      const fan = document.createElement("div");
      fan.className = "fan3";
      ["As", "Kh", "??"].forEach((c, i) => {
        const el = cardEl(c, { deck: val(item.id) });
        el.style.transform = `rotate(${(i - 1) * 12}deg)`;
        fan.append(el);
      });
      box.append(fan);
    } else if (item.type === "room") {
      box.dataset.room = val(item.id);
      box.classList.add("room-bg");
      const mini = document.createElement("div");
      mini.className = "room-mini";
      box.append(mini);
    } else if (item.type === "chips") {
      const row = document.createElement("div");
      row.className = "chips-row";
      for (const d of [5, 25, 100]) row.append(FX.chipStack(0, 46, [d, d, d, d], val(item.id)));
      box.append(row);
    } else if (item.type === "celebration") {
      const stage = document.createElement("div");
      stage.className = "cele-stage";
      const plate = Object.assign(document.createElement("div"), { className: "mini-plate", textContent: "You win 390" });
      const btn = Object.assign(document.createElement("button"), { className: "preview-btn", textContent: "Preview" });
      btn.onclick = () => FX.celebrate(val(item.id), plate, 390, { chipColors: FX.chipColors() });
      stage.append(plate, btn);
      box.append(stage);
    } else if (item.type === "bundle") {
      const room = item.includes.find((i) => i.startsWith("room:"));
      const deck = item.includes.find((i) => i.startsWith("deck:"));
      const chips = item.includes.find((i) => i.startsWith("chips:"));
      if (room) { box.dataset.room = val(room); box.classList.add("room-bg"); }
      const mini = document.createElement("div");
      mini.className = "room-mini";
      const rowEl = document.createElement("div");
      rowEl.className = "mini-row";
      if (deck) for (const c of ["As", "Ah"]) rowEl.append(cardEl(c, { deck: val(deck) }));
      if (chips) rowEl.append(FX.chipStack(0, 26, [100, 100, 100], val(chips)));
      if (!deck && !room) rowEl.append(Object.assign(document.createElement("div"), { className: "mini-plate", textContent: `${item.includes.length} items` }));
      mini.append(rowEl);
      box.append(mini);
    }
    return box;
  }

  function card(item) {
    const el = document.createElement("article");
    el.className = "item";
    el.dataset.item = item.id;
    const bundleOwned = item.type === "bundle" && item.includes.every(owns);
    const owned = item.type === "bundle" ? bundleOwned : owns(item.id);
    const equipped = item.type !== "bundle" && state.equipped[item.type] === item.id;
    if (equipped) el.classList.add("equipped");

    const body = document.createElement("div");
    body.className = "item-body";
    const tier = item.tier === 6 ? "Flagship" : item.pricePence === 0 ? "Included" : `Tier ${item.tier}`;
    body.innerHTML = `<div class="item-tier"></div><div class="item-name"></div><div class="item-desc"></div><div class="item-foot"></div>`;
    body.querySelector(".item-tier").textContent = tier;
    body.querySelector(".item-name").textContent = item.name;
    body.querySelector(".item-desc").textContent = item.description;
    const foot = body.querySelector(".item-foot");

    const price = document.createElement("div");
    price.className = "price" + (item.pricePence === 0 ? " free" : "");
    price.textContent = item.pricePence === 0 ? "Free" : money(item.pricePence);
    if (item.type === "bundle") {
      const separate = item.includes.reduce((a, id) => a + (byId(id)?.pricePence ?? 0), 0);
      if (separate > item.pricePence) price.append(Object.assign(document.createElement("small"), { textContent: `Save ${money(separate - item.pricePence)}` }));
    }
    foot.append(price);

    if (equipped) {
      foot.append(Object.assign(document.createElement("span"), { className: "state-tag", innerHTML: `<svg class="ico"><use href="#i-check"/></svg>Equipped` }));
    } else if (owned && item.type === "bundle") {
      foot.append(Object.assign(document.createElement("span"), { className: "state-tag", innerHTML: `<svg class="ico"><use href="#i-check"/></svg>Owned` }));
    } else if (owned) {
      const b = Object.assign(document.createElement("button"), { className: "btn btn-ivory", textContent: "Equip" });
      b.dataset.action = "equip";
      b.onclick = () => equip(item);
      foot.append(b);
    } else {
      const b = Object.assign(document.createElement("button"), { className: "btn btn-gold", textContent: `Buy ${money(item.pricePence)}` });
      b.dataset.action = "buy";
      b.onclick = () => buy(item, b);
      foot.append(b);
    }
    el.append(preview(item), body);
    return el;
  }

  function render() {
    if (!state) return;
    $("test-banner").hidden = state.mode !== "test";
    document.querySelectorAll(".shop-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("shop-note").textContent = NOTES[tab];
    const items = state.catalog.filter((i) => i.type === tab).sort((a, b) => a.tier - b.tier || a.pricePence - b.pricePence);
    $("shop-grid").replaceChildren(...items.map(card));
  }

  async function buy(item, btn) {
    btn.disabled = true;
    try {
      state = await api("/api/shop/buy", { method: "POST", body: JSON.stringify({ itemId: item.id }) });
      toast(`${item.name} unlocked${state.mode === "test" ? " (test purchase, no payment taken)" : ""}`);
      if (item.type !== "bundle") await equip(item, true);
      else render();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  async function equip(item, quiet = false) {
    try {
      state = await api("/api/shop/equip", { method: "POST", body: JSON.stringify({ itemId: item.id }) });
      onEquip(state.equipped);
      if (!quiet) toast(`${item.name} equipped`);
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  document.querySelectorAll(".shop-tabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  $("shop-close").onclick = () => close();
  addEventListener("keydown", (e) => e.key === "Escape" && close());

  async function open(t) {
    if (t) tab = t;
    if (!state) await load();
    $("shop").hidden = false;
    render();
  }
  function close() { $("shop").hidden = true; }
  return { load, open, close, get state() { return state; } };
}
