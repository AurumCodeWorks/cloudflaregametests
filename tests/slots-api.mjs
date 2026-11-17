// Slot machines against the running server: node tests/slots-api.mjs [baseUrl]   (needs the dev server with AUDIT:1)
// Ledger, pacing, idempotent presses, two tabs at once, crash recovery, and the seed reveal re-verified
// with the same code the browser uses.
import { sha256Hex, verifySpin } from "../public/fair.js";
import { evaluate, MACHINES, reelSizes } from "../public/machines.js";

const B = process.argv[2] || "http://localhost:8787";
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} - ${msg}`); if (!ok) failures++; };
const j = async (path, opts = {}, token) => {
  const r = await fetch(B + path, { ...opts, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return [r.status, await r.json().catch(() => null)];
};
const post = (path, token, body) => j(path, { method: "POST", body: JSON.stringify(body ?? {}) }, token);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
const PACE = 2600;
const audit = async (token) => (await j("/api/audit", {}, token))[1];
const acct = (a, id) => a.accounts.find((x) => x.id === id)?.balance ?? 0;

const [, u] = await post("/api/login", null, { name: "Slotter" });
const T = u.token, me = `user:${u.userId}`;

// 1. sign-in required; state hides the secret
check((await j("/api/slots"))[0] === 401, "slots API without a token is refused");
const [, s0] = await j("/api/slots", {}, T);
check(/^[0-9a-f]{64}$/.test(s0.commit) && /^[0-9a-f]{64}$/.test(s0.nextCommit) && s0.commit !== s0.nextCommit, "state shows the fingerprints of the current and the next server seed");
check(!JSON.stringify(s0).includes("serverSeed") && s0.clientSeed === null && s0.nonce === 0, "the server seed is never sent while in use; no client seed yet");
check(JSON.stringify(s0.stakes) === "[10,20,50,100,200,500]" && s0.minSpinMs >= 2500, "stakes are 10p to £5 and the minimum spin time is 2.5 s");

// 2. spins need a client seed, a real machine and an allowed stake
check((await post("/api/slots/spin", T, { machine: "sevens2", stake: 10, rid: rid() }))[0] === 409, "no spin before the player has supplied a seed");
check((await post("/api/slots/seed", T, { clientSeed: "bad:seed" }))[0] === 400, "a malformed client seed is refused");
const [, s1] = await post("/api/slots/seed", T, { clientSeed: "first-try" });
const [, s2] = await post("/api/slots/seed", T, { clientSeed: "my-seed-1" });
check(s1.revealed === null && s2.revealed === null && s2.commit === s0.commit && s2.clientSeed === "my-seed-1", "before the first spin the client seed can be changed without touching the committed server seed");
for (const [body, why] of [[{ machine: "sevens2", stake: 1000, rid: rid() }, "a £10 stake"], [{ machine: "sevens2", stake: 501, rid: rid() }, "a £5.01 stake"], [{ machine: "sevens2", stake: 5, rid: rid() }, "a 5p stake"], [{ machine: "sevens2", stake: 10.5, rid: rid() }, "a fractional stake"], [{ machine: "sevens2", stake: -10, rid: rid() }, "a negative stake"],
  [{ machine: "sevens", stake: 10, rid: rid() }, "the retired first edition of Lucky Sevens"], [{ machine: "nope", stake: 10, rid: rid() }, "an unknown machine"], [{ machine: "__proto__", stake: 10, rid: rid() }, "a prototype name as machine"], [{ machine: "sevens2", stake: 10 }, "a spin with no press id"]])
  check((await post("/api/slots/spin", T, body))[0] === 400, `${why} is refused`);

// 3. a spin moves exactly stake and payout through the ledger
const before = await audit(T);
const press = rid();
const [st1, r1] = await post("/api/slots/spin", T, { machine: "sevens2", stake: 20, rid: press });
check(st1 === 200 && r1.ok && r1.spin.nonce === 1 && r1.nonce === 1 && r1.spin.stake === 20, "first spin is nonce 1");
check(r1.spin.payout === evaluate("sevens2", r1.spin.stops).mult * 20, "payout is the published paytable times the stake");
const after = await audit(T);
check(after.sum === 0, "ledger still sums to zero");
check(acct(after, me) - acct(before, me) === r1.spin.payout - 20 && r1.balance === acct(after, me), "the player's balance moved by exactly payout minus stake");
check(!JSON.stringify(r1).includes("serverSeed"), "a spin reply never contains the server seed");

// 4. the same press again is the same spin; pressing too soon is refused (no turbo, no double spin)
const [, again] = await post("/api/slots/spin", T, { machine: "sevens2", stake: 20, rid: press });
check(again.ok && again.replay && again.spin.nonce === 1 && JSON.stringify(again.spin.stops) === JSON.stringify(r1.spin.stops), "re-sending the same press returns the same spin, not a new one");
const [tooSoon, soon] = await post("/api/slots/spin", T, { machine: "sevens2", stake: 10, rid: rid() });
check(tooSoon === 429 && soon.retryInMs > 0 && soon.retryInMs <= 2500, "a second spin inside 2.5 s is refused");
check(acct(await audit(T), me) === acct(after, me), "the refused and repeated presses moved no chips");
await wait(PACE);

// 5. two tabs press at the same moment: one spin, not two
const both = await Promise.all([post("/api/slots/spin", T, { machine: "royal", stake: 10, rid: rid() }), post("/api/slots/spin", T, { machine: "sevens2", stake: 10, rid: rid() })]);
check(both.filter(([c]) => c === 200).length === 1 && both.filter(([c]) => c === 429).length === 1, "two simultaneous presses (two tabs, two machines) make exactly one spin");
check((await j("/api/slots", {}, T))[1].nonce === 2, "the nonce advanced by one");
await wait(PACE);

// 6. crash right after the stake is taken: the spin is finished on the next request, paid once
for (const stage of ["stake", "payout"]) {
  let done = false;
  for (let tries = 0; tries < 60 && !done; tries++) {
    const b0 = await audit(T), n0 = (await j("/api/slots", {}, T))[1].nonce;
    await post("/api/slots/debug/crash", T, { stage });
    const p = rid();
    const [code] = await post("/api/slots/spin", T, { machine: "sevens2", stake: 10, rid: p }).catch(() => [0]);
    const [, st] = await j("/api/slots", {}, T); // the restarted object recovers before answering
    const [, replay] = await post("/api/slots/spin", T, { machine: "sevens2", stake: 10, rid: p });
    const b1 = await audit(T);
    if (code === 200) { await wait(PACE); continue; } // (payout stage only) that spin paid nothing, so no crash point was reached
    check(st.nonce === n0 + 1 && replay.ok && replay.replay && replay.spin.nonce === n0 + 1, `crash after the ${stage} transfer: the spin was finished by recovery and the same press replays it`);
    check(b1.sum === 0 && acct(b1, me) - acct(b0, me) === replay.spin.payout - 10, `crash after the ${stage} transfer: stake taken once, payout paid once (${replay.spin.payout})`);
    done = true;
    await wait(PACE);
  }
  check(done, `reached the ${stage} crash point`);
}

// 7. a short run on both machines, then reveal and re-verify everything
const seen = [];
for (let k = 0; k < 6; k++) {
  const machine = k % 2 ? "royal" : "sevens2";
  const [, r] = await post("/api/slots/spin", T, { machine, stake: [10, 20, 50, 100, 200, 500][k], rid: rid() });
  check(r.ok && r.commit === s0.commit && r.spin.payout === evaluate(machine, r.spin.stops).mult * r.spin.stake, `spin ${r.spin?.nonce} on ${MACHINES[machine].name} under the same committed seed`);
  seen.push(r.spin);
  await wait(PACE);
}
const [, st] = await j("/api/slots", {}, T);
// (In demo mode a player who runs short is topped up from the mint; that is its own ledger entry, so allow for it here.)
const end = await audit(T), minted = acct(before, "mint") - acct(end, "mint") - (acct(end, "slots") - acct(before, "slots") + (st.session.returned - st.session.staked));
check(st.session.spins === st.nonce && st.session.returned - st.session.staked === acct(end, me) - acct(before, me) - Math.max(0, minted), "the session's net result equals what the ledger says the player won or lost");
const [, rot] = await post("/api/slots/seed", T, { clientSeed: "my-seed-2" });
check(rot.revealed && (await sha256Hex(rot.revealed.serverSeed)) === s0.commit, "the revealed server seed hashes to the fingerprint published before the first spin");
check(rot.commit === s0.nextCommit && rot.nonce === 0 && rot.seedNo === 2 && rot.clientSeed === "my-seed-2", "the next seed is the one whose fingerprint was promised in advance; the nonce restarts");
const [, hist] = await j(`/api/slots/history?seed=1`, {}, T);
check(hist.spins.length === rot.revealed.spins && hist.spins.every((sp, i) => sp.nonce === i + 1), "the history holds every spin of that seed, with no gaps");
let allOk = true;
for (const sp of hist.spins) {
  const ok = await verifySpin({ commit: s0.commit, serverSeed: rot.revealed.serverSeed, clientSeed: "my-seed-1", nonce: sp.nonce, machine: sp.machine, sizes: reelSizes(sp.machine), stops: sp.stops });
  if (!ok || evaluate(sp.machine, sp.stops).mult * sp.stake !== sp.payout) allOk = false;
}
check(allOk, `all ${hist.spins.length} spins re-verify from the revealed seed with the browser's code, and were paid per the paytable`);
check(seen.every((sp) => { const h = hist.spins.find((x) => x.nonce === sp.nonce); return h && JSON.stringify(h.stops) === JSON.stringify(sp.stops) && h.payout === sp.payout; }), "the history matches what each spin reply showed");
const tampered = { ...hist.spins[0], stops: hist.spins[0].stops.map((x, i) => (i ? x : (x + 1) % reelSizes(hist.spins[0].machine)[0])) };
check(!(await verifySpin({ commit: s0.commit, serverSeed: rot.revealed.serverSeed, clientSeed: "my-seed-1", nonce: tampered.nonce, machine: tampered.machine, sizes: reelSizes(tampered.machine), stops: tampered.stops })), "a tampered stop fails verification");
const [, seeds] = await j("/api/slots/seeds", {}, T);
check(seeds.seeds.length === 1 && seeds.seeds[0].serverSeed === rot.revealed.serverSeed, "revealed seeds are listed for later re-checking");

// 8. another player can't read this player's history, and has their own seeds
const [, v] = await post("/api/login", null, { name: "Other" });
const [, theirs] = await j(`/api/slots/history?seed=1`, {}, v.token);
const [, vs] = await j("/api/slots", {}, v.token);
check(theirs.spins.length === 0 && theirs.revealed === null && vs.commit !== s0.commit && vs.commit !== rot.commit, "players have separate seeds and can't see each other's spins");

// 9. stopping ends the session and reports it once
const [, stop] = await post("/api/slots/stop", T);
check(stop.ended?.spins === st.session.spins && stop.session === null, "Stop ends the session and returns its totals");
check((await audit(T)).sum === 0, "ledger sums to zero at the end");

console.log(failures ? `\n${failures} FAILED` : "\nall slot API checks passed");
process.exit(failures ? 1 : 0);
