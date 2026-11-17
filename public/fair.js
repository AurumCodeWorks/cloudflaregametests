// Provably-fair check, shared by the live client, the showroom and the Node tests.
// Before dealing, the server publishes commit = sha256(leaf0,...,leaf51) with leaf = sha256("<card>:<salt>").
// After the hand each player gets, for every deck position, either {card, salt} (a card they saw) or {leaf}.

export async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Where each card comes from in the deck, mirroring the engine (src/holdem.ts): two rounds of one hole
 * card each, starting left of the button, then burn + flop, burn + turn, burn + river.
 * `dealtIn[i]` says whether seat i was dealt into the hand.
 */
export function dealPositions(button, dealtIn) {
  const n = dealtIn.length;
  const order = [];
  for (let k = 1; k <= n; k++) if (dealtIn[(button + k) % n]) order.push((button + k) % n);
  const c = order.length;
  const hole = {};
  order.forEach((seat, k) => (hole[seat] = [k, c + k]));
  return { hole, board: [2 * c + 1, 2 * c + 2, 2 * c + 3, 2 * c + 5, 2 * c + 7] };
}

/**
 * True only if the revealed deck hashes to the fingerprint published before the deal AND every card
 * you saw (board, your hole cards, hands shown at showdown) sat at its proper place in that deck.
 * Without the position check any card would "verify", since every card is somewhere in a deck.
 */
export async function verifyDeal({ commit, reveal, button, dealtIn, board, holes }) {
  if (!Array.isArray(reveal) || reveal.length !== 52) return false;
  const leaves = await Promise.all(reveal.map((r) => ("leaf" in r ? r.leaf : sha256Hex(`${r.card}:${r.salt}`))));
  if ((await sha256Hex(leaves.join(","))) !== commit) return false;
  const pos = dealPositions(button, dealtIn);
  const at = (p) => reveal[p]?.card;
  if (!board.every((card, k) => at(pos.board[k]) === card)) return false;
  return Object.entries(holes).every(([seat, cards]) => pos.hole[seat] && cards.every((card, k) => at(pos.hole[seat][k]) === card));
}
