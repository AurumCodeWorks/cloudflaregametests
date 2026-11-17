// Game audio. Short effects play through Web Audio (instant, can overlap); music streams through
// <audio> elements with a crossfade at the loop point. Files come from R2 via /audio/<version>/
// and are cached by the browser for good, so each device downloads them once.
//
// Nothing makes a sound until the player interacts (browsers require it), and music stays off
// until they turn it on. Settings are remembered on this device.

const BASE = "/audio/v1/";
export const EFFECTS = [
  "shuffle", "card-deal", "card-flip", "fold", "check", "chip-bet", "chip-stack", "all-in", "pot-win",
  "your-turn", "timer-tick", "ui-click", "unlock",
  "celebrate-glow", "celebrate-chipshower", "celebrate-confetti", "celebrate-spotlight", "celebrate-fireworks", "celebrate-goldrush",
];
// One track per room style; gains bring the three to the same loudness (measured at -15.4, -13.6, -15.0 LUFS)
const MUSIC_FOR_ROOM = { classic: "music-lounge", midnight: "music-lounge", speakeasy: "music-speakeasy", riviera: "music-riviera", vegas: "music-riviera", penthouse: "music-riviera" };
const MUSIC_GAIN = { "music-lounge": 0.93, "music-riviera": 0.76, "music-speakeasy": 0.89 };
export const TRACK_NAMES = { "music-lounge": "Lounge piano and bass", "music-speakeasy": "Speakeasy swing", "music-riviera": "Riviera bossa" };
const CROSSFADE_S = 3;

const DEFAULTS = { effects: true, effectsVolume: 0.8, music: false, musicVolume: 0.35 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem("sound") || "{}")); } catch {}
const persist = () => { try { localStorage.setItem("sound", JSON.stringify(settings)); } catch {} };

let ctx = null, effectsBus = null, musicBus = null;
const buffers = {};
let room = "classic";
const debug = { played: [], track: null, musicTime: () => (active && !active.el.paused ? active.el.currentTime : 0), state: () => ctx?.state ?? "none",
  nearEnd: () => { if (active) active.el.currentTime = active.el.duration - 4; } }; // read by the tests
if (typeof window !== "undefined") window.__sound = debug;

/** Call from a click or key press: creates the audio engine and starts loading the effects. */
export function unlock() {
  if (ctx) { if (ctx.state === "suspended" && !document.hidden) ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  effectsBus = ctx.createGain();
  musicBus = ctx.createGain();
  effectsBus.connect(ctx.destination);
  musicBus.connect(ctx.destination);
  applyVolumes();
  for (const name of EFFECTS) load(name);
  if (settings.music) startMusic();
  // Pause everything while the tab is hidden: saves battery, and nobody hears a background tab
  document.addEventListener("visibilitychange", () => (document.hidden ? ctx.suspend() : ctx.resume()));
}

function load(name) {
  return (buffers[name] ??= fetch(BASE + name + ".mp3")
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    .then((data) => ctx.decodeAudioData(data))
    .catch(() => null));
}

/** Play an effect, optionally after `delay` ms (scheduled on the audio clock, so it stays in time). */
export function play(name, { delay = 0, volume = 1 } = {}) {
  if (!ctx || !settings.effects || !EFFECTS.includes(name)) return;
  const at = ctx.currentTime + Math.max(0, delay) / 1000;
  load(name).then((buf) => {
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(effectsBus);
    src.start(Math.max(at, ctx.currentTime));
    debug.played.push(name);
    if (debug.played.length > 200) debug.played.splice(0, 100);
  });
}

/**
 * Play an effect as a seamless loop (a reel-spin bed). Returns a function that fades it out and stops it.
 * The loop points sit just inside the file, past the short silence MP3 encoding adds at each end.
 */
export function loop(name, { volume = 1 } = {}) {
  if (!ctx || !settings.effects || !EFFECTS.includes(name)) return () => {};
  let src = null, g = null, stopped = false;
  load(name).then((buf) => {
    if (!buf || stopped) return;
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = Math.min(0.06, buf.duration / 4);
    src.loopEnd = buf.duration - Math.min(0.06, buf.duration / 4);
    g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.12);
    src.connect(g).connect(effectsBus);
    src.start();
    debug.played.push(name);
  });
  return () => {
    stopped = true;
    if (!src) return;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + 0.18);
    src.stop(now + 0.2);
  };
}

// ---------------------------------------------------------------- music
const decks = []; // two <audio> players, swapped at each loop point
let active = null;
function player(name) {
  const el = new Audio(BASE + name + ".mp3");
  el.preload = "auto";
  const node = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  node.connect(gain).connect(musicBus);
  const p = { el, gain, name, crossing: false };
  // Start the other player and crossfade just before this one ends, so the loop has no gap
  el.addEventListener("timeupdate", () => {
    if (active === p && !p.crossing && el.duration && el.duration - el.currentTime < CROSSFADE_S) {
      p.crossing = true;
      fadeTo(p.name);
    }
  });
  return p;
}
function fadeTo(name) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const next = decks.find((d) => d !== active && d.name === name) ?? (() => {
    const old = decks.find((d) => d !== active);
    if (old) { old.el.pause(); old.el.removeAttribute("src"); decks.splice(decks.indexOf(old), 1); }
    const p = player(name);
    decks.push(p);
    return p;
  })();
  next.crossing = false;
  next.el.currentTime = 0;
  next.el.play().catch(() => {});
  next.gain.gain.cancelScheduledValues(now);
  next.gain.gain.setValueAtTime(0, now);
  next.gain.gain.linearRampToValueAtTime(MUSIC_GAIN[name] ?? 1, now + CROSSFADE_S);
  if (active) {
    const prev = active;
    prev.gain.gain.cancelScheduledValues(now);
    prev.gain.gain.setValueAtTime(prev.gain.gain.value, now);
    prev.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
    setTimeout(() => { if (active !== prev) prev.el.pause(); }, CROSSFADE_S * 1000 + 100);
  }
  active = next;
  debug.track = name;
}
function startMusic() {
  if (!ctx) return;
  const name = MUSIC_FOR_ROOM[room] ?? "music-lounge";
  if (active?.name === name && !active.el.paused) return;
  fadeTo(name);
}
function stopMusic() {
  if (!active || !ctx) return;
  const now = ctx.currentTime, prev = active;
  prev.gain.gain.cancelScheduledValues(now);
  prev.gain.gain.setValueAtTime(prev.gain.gain.value, now);
  prev.gain.gain.linearRampToValueAtTime(0, now + 0.6);
  setTimeout(() => prev.el.pause(), 700);
  active = null;
  debug.track = null;
}

/** The room decides the music; a change of room crossfades to its track. */
export function setRoom(name) {
  room = name;
  if (ctx && settings.music && active && active.name !== (MUSIC_FOR_ROOM[room] ?? "music-lounge")) startMusic();
}
export function currentTrack() { return settings.music ? TRACK_NAMES[MUSIC_FOR_ROOM[room] ?? "music-lounge"] : null; }

// ---------------------------------------------------------------- settings
function applyVolumes() {
  if (!ctx) return;
  effectsBus.gain.value = settings.effects ? settings.effectsVolume : 0;
  musicBus.gain.value = settings.music ? settings.musicVolume : 0;
}
export function getSettings() { return { ...settings }; }
export function set(patch) {
  const wasMusic = settings.music;
  Object.assign(settings, patch);
  persist();
  unlock(); // a settings change is itself a click, so the engine can start here
  applyVolumes();
  if (settings.music && !wasMusic) startMusic();
  if (!settings.music && wasMusic) stopMusic();
}
