import "./style.css";
import "vanilla-colorful/hex-color-picker.js";
import type { HexColorPicker } from "vanilla-colorful/hex-color-picker.js";
import {
  type Rect,
  COLORWAYS,
  LABEL_GAP,
  LABEL_WEIGHT,
  getLogoImages,
  labelColors,
  logoRect,
  colorwayIndex,
  DEFAULT_PARAMS,
  FORMATS,
  STACK_KEYS,
  buildScene,
  coverRect,
  render,
  type Colors,
  type Format,
  type ImageSource,
  type Layout,
  type LayoutKind,
  type BlockColor,
  type LogoColor,
  type LogoPos,
  type LogoStyle,
  LOGO_STYLES,
  ICON_POSITIONS,
  INFO_KEYS,
  infoSizeOf,
  infoSizeLabel,
  INFO_SIZES,
  INFO_SIZE_MIN,
  INFO_SIZE_MAX,
  type BgColor,
  freeGroups,
  isInfoKey,
  type IconPos,
  contrastText,
  type Params,
  type Scene,
  type SpecRow,
  type SpecShape,
  type StackKey,
  type StaggerOrder,
} from "./engine";
import { exportMp4, exportPng, fontsReady, supportsVideoExport, type BeforeFrame } from "./export";
import { loadLogo } from "./logo";
import { buildIdmlZip } from "./indesign";
import { buildIllustratorSvg } from "./illustrator";
import { audioPackets, loadAudioFile, playAudio, stopAudio, windowPeaks, type AudioTrack } from "./audio";
import { importVideo, type VideoClip } from "./video";

const FPS = 60; // frame counter, arrow-key stepping and MP4 export
const TICKS_PER_SECOND = 15; // timeline tick pitch
const EXPORT_SCALE = 1; // 1080 wide: 1080x1080, 1080x1350, 1080x1920

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const stageEl = $<HTMLDivElement>("stage");
const previewEl = $<HTMLElement>("preview");
const fileInput = $<HTMLInputElement>("fileInput");
const sidebar = $<HTMLElement>("sidebar");
const frameBtn = $<HTMLButtonElement>("frameBtn");
const ticksEl = $<HTMLDivElement>("ticks");
const timelineEl = $<HTMLDivElement>("timeline");
const exportPngBtn = $<HTMLButtonElement>("exportPngBtn");
const exportMp4Btn = $<HTMLButtonElement>("exportMp4Btn");

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const params: Params = structuredClone(DEFAULT_PARAMS);
let scene: Scene = buildScene(params);
let image: ImageSource | null = null;
let layout: Layout = { artistRect: null, stackRect: null, blocks: {} };
let time = 0; // seconds into the loop
let playing = false;

// ---------- render scheduling ----------

let raf = 0;
function draw() {
  layout = render(ctx, params, scene, time % scene.tl.total, 1, image);
  drawFalloffHandle();
  drawResizeHandles();
}
function schedule() {
  syncHash();
  if (raf || playing) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

// ---------- settings in the URL ----------
// Every value that differs from the defaults lives in the hash, so the link
// itself carries the settings (the photo excepted).

type Flat = Record<string, string | number | boolean>;
function flatten(obj: object, prefix = ""): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, `${prefix}${k}.`));
    else if (Array.isArray(v)) out[`${prefix}${k}`] = v.join(",");
    else out[`${prefix}${k}`] = v as string | number | boolean;
  }
  return out;
}
function serializeHash(): string {
  const cur = flatten(params);
  const def = flatten(DEFAULT_PARAMS);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(cur)) {
    if (String(v) === String(def[k])) continue;
    q.set(k, typeof v === "number" ? String(Math.round(v * 10000) / 10000) : String(v));
  }
  return q.toString();
}
let hashTimer = 0;
let lastHash = "";
function syncHash() {
  if (hashTimer) return;
  hashTimer = window.setTimeout(() => {
    hashTimer = 0;
    const h = serializeHash();
    if (h === lastHash) return;
    recordHistory(lastHash, h);
    lastHash = h;
    storeFigmaSettings(h);
    try {
      history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
    } catch {
      // sandboxed frames (a Figma code layer) may refuse to touch the URL
    }
  }, 150);
}
// Inside a Figma code layer there is no address bar and nobody to press play:
// the build made by .figma/make sets VITE_FIGMA, which starts the loop on its
// own and falls back to these settings when the URL carries none.
const FIGMA_LAYER = Boolean(import.meta.env.VITE_FIGMA);
const FIGMA_SETTINGS =
  "floatCount=4&floatSize=5&vignette=100&shapeSeed=6&colors.topA=%23FF63F4&colors.topB=%23ED00A5&colors.bottomA=%2370FFDF&colors.bottomB=%231625F8&imageZoom=1.4034&imageX=-0.1337&imageY=-0.1188";
// A code layer cannot keep its settings in the URL either, so they are kept
// in the browser's storage and picked up again when the preview restarts.
const FIGMA_STORE = "artist-card.settings";
function storeFigmaSettings(h: string) {
  if (!FIGMA_LAYER) return;
  try {
    localStorage.setItem(FIGMA_STORE, h);
  } catch {
    // storage can be blocked in a sandboxed frame
  }
}
function storedFigmaSettings(): string {
  if (!FIGMA_LAYER) return "";
  try {
    return localStorage.getItem(FIGMA_STORE) ?? FIGMA_SETTINGS;
  } catch {
    return FIGMA_SETTINGS;
  }
}
function readHash(): boolean {
  const h = location.hash.replace(/^#/, "") || storedFigmaSettings();
  if (!h) return false;
  lastHash = h;
  return applySettings(parseHash(h));
}
/** The settings in a hash string, as the JSON applySettings takes. */
function parseHash(h: string): string {
  const q = new URLSearchParams(h);
  const obj: Record<string, unknown> = {};
  const def = flatten(DEFAULT_PARAMS);
  for (const [k, v] of q.entries()) {
    const freeKey = k.startsWith("free.");
    if (!(k in def) && !freeKey) continue;
    const value: unknown =
      k === "easing"
        ? v.split(",").map(Number)
        : k === "stack"
          ? v.split(",").filter(Boolean)
          : /^info\d?Size$/.test(k) && /^[sml]$/.test(v)
            ? v // an older link: the size as a letter
            : freeKey || typeof def[k] === "number"
              ? parseFloat(v)
              : v;
    const path = k.split(".");
    let host = obj;
    for (const part of path.slice(0, -1)) {
      host[part] = (host[part] as Record<string, unknown>) ?? {};
      host = host[part] as Record<string, unknown>;
    }
    host[path[path.length - 1]] = value;
  }
  return JSON.stringify(obj);
}

// ---------- undo / redo ----------
// Every state is its hash string. A change that keeps touching the same
// settings (a slider drag, typing in a field) is one step; the stacks hold
// the state before each step. Photos, video and music are not part of it.

const HISTORY_MAX = 200;
const HISTORY_MERGE_MS = 1200;
const undoStack: string[] = [];
const redoStack: string[] = [];
let restoring = false;
let lastEditKeys = "";
let lastEditAt = 0;
function changedKeys(a: string, b: string): string {
  const qa = new URLSearchParams(a);
  const qb = new URLSearchParams(b);
  const keys = new Set<string>();
  for (const [k, v] of qa) if (qb.get(k) !== v) keys.add(k);
  for (const [k, v] of qb) if (qa.get(k) !== v) keys.add(k);
  return [...keys].sort().join(" ");
}
function recordHistory(prev: string, next: string) {
  if (restoring) return;
  const keys = changedKeys(prev, next);
  const now = performance.now();
  if (undoStack.length && keys === lastEditKeys && now - lastEditAt < HISTORY_MERGE_MS) {
    lastEditAt = now; // the same control still moving: part of the same step
    return;
  }
  undoStack.push(prev);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  lastEditKeys = keys;
  lastEditAt = now;
}
/** Put the tool in the state `h` describes, defaults for everything it leaves out. */
function restoreState(h: string) {
  restoring = true;
  if (hashTimer) {
    clearTimeout(hashTimer);
    hashTimer = 0;
  }
  const prevPreset = params.preset;
  const artist2Was = !!params.artist2;
  Object.assign(params, structuredClone(DEFAULT_PARAMS));
  applySettings(parseHash(h));
  if (!params.artist2 && artist2Was) showArtist2(false);
  syncUI();
  applyFormat();
  rebuild();
  if (params.preset !== prevPreset) loadPhotoUrl(presetPhoto(params.preset));
  lastHash = h;
  storeFigmaSettings(h);
  try {
    history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
  } catch {
    // sandboxed frames
  }
  lastEditKeys = "";
  restoring = false;
}
function undo() {
  if (!undoStack.length) return;
  const cur = serializeHash();
  const prev = undoStack.pop()!;
  if (prev === cur) return undo();
  redoStack.push(cur);
  restoreState(prev);
}
function redo() {
  if (!redoStack.length) return;
  const cur = serializeHash();
  const next = redoStack.pop()!;
  if (next === cur) return redo();
  undoStack.push(cur);
  restoreState(next);
}
function rebuild() {
  scene = buildScene(params);
  if (time > exportLength()) time = 0;
  buildTicks();
  markKeyframes();
  syncTime();
  if (audio) setAudioStart(audioStart);
  if (video) setVideoStart(videoStart);
  schedule();
}

// ---------- timeline ----------

let tickEls: HTMLElement[] = [];
let activeTick = -1;
let ticksWidth = 0; // css px available for the tick strip
function buildTicks() {
  // one tick per 1/15 s, fewer when the strip is too narrow (3 px ticks,
  // at least 2.5 px apart) so the timeline always fits under the card
  const wanted = Math.max(2, Math.round(exportLength() * TICKS_PER_SECOND));
  const fit = ticksWidth > 0 ? Math.floor((ticksWidth + 2.5) / 5.5) : wanted;
  const n = Math.max(2, Math.min(wanted, fit));
  if (n === tickEls.length) return;
  ticksEl.innerHTML = "";
  tickEls = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("i");
    ticksEl.appendChild(el);
    tickEls.push(el);
  }
  activeTick = -1;
  markKeyframes();
}
/** The times (over the whole export) where the layout's resolved state starts and ends. */
function keyframeTimes(): number[] {
  const kf = scene.keyframes;
  if (!kf) return [];
  const out: number[] = [];
  for (let l = 0; l < Math.max(1, params.loops); l++) out.push(kf.start + l * scene.tl.total, kf.end + l * scene.tl.total);
  return out;
}
/** Colour the ticks inside the resolved state, and its two ends. */
function markKeyframes() {
  const kf = scene.keyframes;
  const total = exportLength();
  const n = tickEls.length;
  const loops = Math.max(1, params.loops);
  tickEls.forEach((el, i) => {
    const t = ((i + 0.5) / n) * total;
    const tl = t % scene.tl.total;
    const inside = !!kf && tl >= kf.start && tl <= kf.end;
    el.classList.toggle("key", inside);
    let edge = false;
    if (kf) {
      const step = total / n;
      for (let l = 0; l < loops; l++) {
        for (const k of [kf.start, kf.end]) {
          const kt = k + l * scene.tl.total;
          if (Math.abs(kt - t) <= step / 2) edge = true;
        }
      }
    }
    el.classList.toggle("edge", edge);
  });
}
function syncTime() {
  const total = exportLength();
  frameBtn.textContent = String(Math.round(time * FPS));
  const n = tickEls.length;
  const idx = total > 0 ? clamp(Math.floor((time / total) * n), 0, n - 1) : 0;
  if (idx !== activeTick) {
    tickEls[activeTick]?.classList.remove("on");
    tickEls[idx]?.classList.add("on");
    activeTick = idx;
  }
  syncWaveHead();
}
function scrubAt(clientX: number, snap = false) {
  const r = ticksEl.getBoundingClientRect();
  if (r.width <= 0) return;
  const total = exportLength();
  let t = clamp((clientX - r.left) / r.width, 0, 1) * total;
  if (snap) {
    // Shift: snap to the nearest keyframe within 12 px
    const reach = (12 / r.width) * total;
    let best: number | null = null;
    for (const k of keyframeTimes()) if (Math.abs(k - t) <= reach && (best === null || Math.abs(k - t) < Math.abs(best - t))) best = k;
    if (best !== null) t = best;
  }
  setTime(t);
}
let scrubbing = false;
ticksEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  scrubbing = true;
  ticksEl.setPointerCapture(e.pointerId);
  scrubAt(e.clientX, e.shiftKey);
});
ticksEl.addEventListener("pointermove", (e) => {
  if (scrubbing) scrubAt(e.clientX, e.shiftKey);
});
for (const ev of ["pointerup", "pointercancel"]) ticksEl.addEventListener(ev, () => (scrubbing = false));

// The timeline is as wide as the displayed card.
new ResizeObserver(() => {
  const w = canvas.getBoundingClientRect().width;
  timelineEl.style.width = `${w}px`;
  waveEl.style.width = `${w}px`;
  ticksWidth = Math.max(0, w - 50); // frame counter 40 + gap 10
  buildTicks();
  syncTime();
  buildWave();
}).observe(canvas);

// ---------- playback ----------

let playStart = 0;
let playOffset = 0;
let playLoops = 0;
function tick(now: number) {
  if (!playing) return;
  // the timeline spans the whole export (the loop times Loops); the music
  // starts over with it
  const total = exportLength();
  const elapsed = (now - playStart) / 1000 + playOffset;
  time = total > 0 ? elapsed % total : 0;
  const loops = total > 0 ? Math.floor(elapsed / total) : 0;
  if (loops !== playLoops) {
    playLoops = loops;
    if (audio) playAudio(audio, audioStart + time);
  }
  syncTime();
  if (video) syncVideo();
  draw();
  requestAnimationFrame(tick);
}
function setPlaying(p: boolean) {
  if (p === playing) return;
  playing = p;
  frameBtn.classList.toggle("playing", playing);
  if (playing) {
    playStart = performance.now();
    playOffset = time;
    playLoops = 0;
    if (audio) playAudio(audio, audioStart + time);
    if (video) syncVideo();
    requestAnimationFrame(tick);
  } else {
    stopAudio();
    if (video) syncVideo();
    schedule();
  }
}
function setTime(t: number) {
  if (playing) setPlaying(false);
  time = clamp(t, 0, exportLength());
  syncTime();
  syncVideo();
  schedule();
}
frameBtn.addEventListener("click", () => setPlaying(!playing));

/** Click the button after (or before) the active one in a segmented row. */
function cycleSeg(id: string, dir: 1 | -1) {
  const btns = Array.from($<HTMLDivElement>(id).querySelectorAll<HTMLButtonElement>("button"));
  const i = btns.findIndex((b) => b.classList.contains("active"));
  btns[(i + dir + btns.length) % btns.length]?.click();
}
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName ?? "";
  const inField = !!t?.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || tag === "INPUT";
  if (e.metaKey || e.ctrlKey) {
    if (e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "a" && inField && (tag === "INPUT" || tag === "TEXTAREA")) {
      e.preventDefault();
      (t as HTMLInputElement | HTMLTextAreaElement).select();
      return;
    }
    if (k === "z") {
      if (inField) return; // the field's own undo
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (k === "s") {
      e.preventDefault();
      $<HTMLButtonElement>("saveBtn").click();
    } else if (k === "o") {
      e.preventDefault();
      $<HTMLButtonElement>("loadBtn").click();
    } else if (k === "i") {
      e.preventDefault();
      $<HTMLButtonElement>("imageLoadBtn").click();
    } else if (k === "e") {
      e.preventDefault();
      (e.shiftKey ? exportPngBtn : exportMp4Btn).click();
    }
    return;
  }
  if (inField) return;
  if (e.altKey) return;
  if (e.key === "?") {
    e.preventDefault();
    helpEl.classList.toggle("pinned");
    return;
  }
  if (e.key === "Escape" && helpEl.classList.contains("pinned")) {
    helpEl.classList.remove("pinned");
    return;
  }
  if (e.key >= "1" && e.key <= "4" && !e.shiftKey) {
    e.preventDefault();
    document.querySelector<HTMLButtonElement>(`[data-preset="${e.key}"]`)?.click();
    return;
  }
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    cycleSeg("formatSeg", e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "l" || e.key === "L") {
    e.preventDefault();
    cycleSeg("logoSeg", e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    stepColorway(e.key === "ArrowUp" ? 1 : -1);
    return;
  }
  if (e.key === "End") {
    e.preventDefault();
    setTime(exportLength() - 1 / FPS);
    return;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && drag === "block" && dragKey) {
    // Backspace while holding a block row clears its text, so the row goes
    e.preventDefault();
    clearBlock(dragKey);
    return;
  }
  if (e.key === "Escape" && falloffSelected) {
    falloffSelected = false;
    schedule();
    return;
  }
  if (e.code === "Space" || e.key === " ") {
    if (e.repeat || tag === "BUTTON") return; // let focused buttons activate
    e.preventDefault();
    setPlaying(!playing);
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    const frames = e.shiftKey ? 10 : 1;
    setTime(time + (dir * frames) / FPS);
  } else if (e.key === "Home") {
    e.preventDefault();
    setTime(0);
  }
});

// ---------- segmented buttons ----------

function bindSeg<T extends string>(id: string, attr: string, onPick: (value: T) => void): (value: T) => void {
  const seg = $<HTMLDivElement>(id);
  const btns = Array.from(seg.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`));
  const setActive = (value: T) => {
    for (const b of btns) b.classList.toggle("active", b.dataset[attr] === value);
  };
  for (const b of btns) {
    b.addEventListener("click", () => {
      const v = b.dataset[attr] as T;
      setActive(v);
      onPick(v);
    });
  }
  return setActive;
}
const setFormatUI = bindSeg<Format>("formatSeg", "format", (v) => {
  params.format = v;
  applyFormat();
  rebuild();
});
// Layout presets: the examples from the Figma sheet (frame 442:25032).
// Each one is a complete state, photo included; 1 is the reveal with the
// default photo. Applying a preset resets everything but the format.
const EDGE = 51.5 / 675; // the examples' margin, as a fraction of the height
const INFO_H = (12 + 12 * 0.694 + 12) / 675; // the sentence block's height
const PRESET_NAMES: Record<number, string> = { 1: "Reveal", 2: "Infos Pratiques", 3: "Full blocks", 4: "App TMB26", 5: "Paragraph" };
const PRESETS: Record<number, Partial<Params>> = {
  1: {},
  2: {
    layout: "side",
    rowsTop: 4,
    rowsBottom: 4,
    blockWidth: 3,
    unitPx: 24,
    title: "Infos\nPratiques",
    day: "",
    timeStart: "",
    timeEnd: "",
    artist: "",
    stage: "",
    info: "Tout ce qu\u2019il faut savoir pour pr\u00e9parer ton arriv\u00e9e au TMB !",
    infoSize: INFO_SIZES.s,
    free: { info: 1 - EDGE - INFO_H / 2 },
    stackAnchor: "top",
    stackY: EDGE,
    colors: { ...DEFAULT_PARAMS.colors, topA: "#8D5DF3", topB: "#0906B7", bottomA: "#70FF97", bottomB: "#00FA7D" },
  },
  3: {
    layout: "full",
    rowsTop: 4,
    rowsBottom: 4,
    blockWidth: 2,
    day: "Thursday 28.08",
    timeStart: "",
    timeEnd: "",
    artist: "Chris Stussy",
    stage: "",
    stackAnchor: "top",
    stackY: EDGE,
    logo: "bottom",
    logoColor: "white",
    colors: { ...DEFAULT_PARAMS.colors, topA: "#E90062", topB: "#70FFDF", bottomA: "#F3705D", bottomB: "#F99390" },
    opening: 90,
    vignette: 100,
    faith: 100,
    irregularity: 0,
    falloffX: 0.5,
    falloffY: 0.5,
    falloffR: 0.36,
    imageX: 0.42,
  },
  4: {
    layout: "row",
    rowsTop: 0,
    rowsBottom: 2,
    title: "App TMB26",
    day: "",
    timeStart: "",
    timeEnd: "",
    artist: "",
    stage: "",
    info: "Disponible en t\u00e9l\u00e9chargement !",
    infoSize: INFO_SIZES.m,
    stackAnchor: "top",
    stackY: EDGE,
    colors: { ...DEFAULT_PARAMS.colors, topA: "#8D5DF3", topB: "#0906B7", bottomA: "#FF63F4", bottomB: "#ED00A5" },
  },
  // the paragraph poster (Figma 612:10222): no photo, a colour, the title
  // and a wrapped text in the middle; Style picks strip rows or the full page
  5: {
    layout: "row",
    rowsTop: 2,
    rowsBottom: 2,
    title: "App TMB26",
    day: "",
    timeStart: "",
    timeEnd: "",
    artist: "",
    stage: "",
    info: "Au TMB, nous mettons un point d\u2019orgue \u00e0 ce que chaque festivalier.e puisse faire la f\u00eate en toute s\u00e9curit\u00e9.\n\nSi vous \u00eates victime ou t\u00e9moin d\u2019un comportement inappropri\u00e9, n\u2019h\u00e9sitez pas \u00e0 solliciter nos \u201cAngels\u201d qui sont d\u00e9ploy\u00e9s gr\u00e2ce \u00e0 l\u2019aide de l\u2019association @fiertespasdecalais. Vous pouvez les retrouver \u00e0 notre stand pr\u00e9vention, ou sur le site du festival, vous les reconna\u00eetrez gr\u00e2ce \u00e0 leurs gilets roses. \ud83e\udd0d",
    infoSize: INFO_SIZES.m,
    infoW: 463 / 540,
    bgColor: "bottomB",
    stackAnchor: "top",
    stackY: 177.75 / 679,
    colors: { ...DEFAULT_PARAMS.colors, topA: "#FF63F4", topB: "#ED00A5", bottomA: "#8D5DF3", bottomB: "#0906B7" },
  },
};
/** The preset's photo; "" = none (the paragraph poster stands on a colour). */
function presetPhoto(n: number): string {
  if (n === 5) return "";
  return n >= 2 && n <= 4 ? `${import.meta.env.BASE_URL}presets/p${n}.jpg` : `${import.meta.env.BASE_URL}default.jpg`;
}
function applyPreset(n: number) {
  const format = params.format;
  const loops = params.loops;
  Object.assign(params, structuredClone(DEFAULT_PARAMS), structuredClone(PRESETS[n] ?? {}), { format, loops, preset: n });
  showArtist2(false);
  syncUI();
  rebuild();
  loadPhotoUrl(presetPhoto(n));
}
const logoColorRow = $<HTMLDivElement>("logoColorRow");
const logoStyleRow = $<HTMLDivElement>("logoStyleRow");
const logoPosRow = $<HTMLDivElement>("logoPosRow");
function syncLayoutUI() {
  const off = params.logo === "off";
  const icon = params.logoStyle === "icon";
  logoColorRow.hidden = off || icon; // the icon takes the text blocks' colours
  logoStyleRow.hidden = off;
  logoPosRow.hidden = off || !icon;
  setLogoUI(params.logo);
  setLogoColorUI(params.logoColor);
  setLogoStyleUI(params.logoStyle);
  setIconPosUI(params.iconPos);
}
const setPresetUI = bindSeg<string>("layoutSeg", "preset", (v) => applyPreset(Number(v)));
const setLogoUI = bindSeg<LogoPos>("logoSeg", "logo", (v) => {
  params.logo = v;
  syncLayoutUI();
  schedule();
});
const setLoopsUI = bindSeg<string>("loopsSeg", "loops", (v) => {
  params.loops = Number(v);
  rebuild();
});
/** The MP4's length: the loop times the Loops setting. */
function exportLength(): number {
  return scene.tl.total * Math.max(1, params.loops);
}
const setLogoColorUI = bindSeg<LogoColor>("logoColorSeg", "logocolor", (v) => {
  params.logoColor = v;
  schedule();
});
const setLogoStyleUI = bindSeg<LogoStyle>("logoStyleSeg", "logostyle", (v) => {
  params.logoStyle = v;
  syncLayoutUI();
  rebuild(); // the inline icon is a block on the entrance clock
});
const setIconPosUI = bindSeg<IconPos>("iconPosSeg", "iconpos", (v) => {
  params.iconPos = v;
  rebuild();
});
function applyFormat() {
  const [W, H] = FORMATS[params.format];
  canvas.width = W;
  canvas.height = H;
}
const setOrderUI = bindSeg<StaggerOrder>("orderSeg", "order", (v) => {
  params.staggerOrder = v;
  rebuild();
});

// ---------- steppers ----------

type NumKey =
  | "loopLen"
  | "unitPx"
  | "stripPx"
  | "labelTime"
  | "holdClosed"
  | "duration"
  | "opening"
  | "vignette"
  | "faith"
  | "holdOpen"
  | "rowsTop"
  | "rowsBottom"
  | "stagger"
  | "irregularity"
  | "shapeSeed"
  | "blockWidth"
  | "blockTravel"
  | "blockSeed"
  | "floatCount"
  | "floatSize"
  | "floatTravel"
  | "imageFloatCount"
  | "imageFloatSize"
  | "imageFloatTravel";

interface StepDef {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  suffix?: string;
  container: string;
  title?: string;
  control?: "slider"; // a row of ticks instead of a stepper
}
const stepDefs: StepDef[] = [
  { key: "holdClosed", label: "Hold closed", min: 0, max: 20, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup" },
  { key: "duration", label: "Opening time", min: 0.1, max: 6, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup", title: "One row's open / close transition; the block moves follow the same easing" },
  { key: "opening", control: "slider", label: "Opening", min: 0, max: 100, step: 5, decimals: 0, suffix: "%", container: "timingGroup", title: "How far the rows open; the edge blocks stay on top of that" },
  { key: "vignette", control: "slider", label: "Vignette", min: 0, max: 100, step: 5, decimals: 0, suffix: "%", container: "timingGroup", title: "How much the hole follows the falloff circle on the preview: 0 = two vertical lines, 100 = the circle" },
  { key: "faith", control: "slider", label: "Faith", min: 0, max: 100, step: 5, decimals: 0, suffix: "%", container: "timingGroup", title: "100 = the hole follows the falloff, 0 = complete chaos (a random width per row and side)" },
  { key: "holdOpen", label: "Hold open", min: 0, max: 30, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup" },
  { key: "labelTime", label: "Text time", min: 0.3, max: 3, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup", title: "How long one label block takes to come in or go" },
  { key: "loopLen", label: "Loop length", min: 0.5, max: 30, step: 0.5, decimals: 1, suffix: "s", container: "timingGroup", title: "One-stage posters: how long the stripes' motion cycle is" },
  { key: "rowsTop", label: "Rows top", min: 0, max: 24, step: 1, decimals: 0, container: "rowsGroup" },
  { key: "rowsBottom", label: "Rows bottom", min: 0, max: 24, step: 1, decimals: 0, container: "rowsGroup" },
  { key: "stripPx", label: "Strip height", min: 12, max: 120, step: 6, decimals: 0, container: "rowsGroup", title: "Block row: height of one strip row in px at 1080" },
  { key: "stagger", label: "Rows stagger", min: 0, max: 1, step: 0.05, decimals: 2, container: "shapeGroup", title: "Seconds between rows; the closing runs in reverse order" },
  { key: "irregularity", control: "slider", label: "Irregularity %", min: 0, max: 100, step: 5, decimals: 0, suffix: "%", container: "shapeGroup", title: "Extra blocks left standing per row and side, more towards the outer rows" },
  { key: "shapeSeed", label: "Shape seed", min: 0, max: 999999, step: 1, decimals: 0, container: "shapeGroup" },
  { key: "unitPx", label: "Block size", min: 12, max: 90, step: 3, decimals: 0, container: "blocksGroup", title: "The stripe unit in px at 1080: 45 in the reveal, 24 for the side blocks" },
  { key: "blockWidth", control: "slider", label: "Block width", min: 1, max: 8, step: 1, decimals: 0, container: "blocksGroup", title: "Widest edge block in an open row, in units (one unit = card width / 24); the blocks breathe two units below that" },
  { key: "blockTravel", control: "slider", label: "Block travel", min: 0, max: 12, step: 1, decimals: 0, container: "blocksGroup", title: "Largest sideways step of a row's pattern, in units" },
  { key: "blockSeed", label: "Block seed", min: 0, max: 999999, step: 1, decimals: 0, container: "blocksGroup" },
  { key: "floatCount", control: "slider", label: "Floaters", min: 0, max: 60, step: 1, decimals: 0, container: "floatGroup", title: "Floating blocks spread over the open rows; they grow, shrink to nothing and back, and drift" },
  { key: "floatSize", control: "slider", label: "Floaters size", min: 0.5, max: 8, step: 0.5, decimals: 1, container: "floatGroup", title: "Largest floating block in units (smallest is half)" },
  { key: "floatTravel", control: "slider", label: "Floaters travel", min: 0, max: 600, step: 10, decimals: 0, container: "floatGroup", title: "Largest sideways step of a floating block, px on the 1080 canvas" },
  { key: "imageFloatCount", control: "slider", label: "Image floaters", min: 0, max: 60, step: 1, decimals: 0, container: "floatGroup", title: "Floating blocks inside the photo or video: slices of it pushed sideways; they grow, shrink to nothing and back, and drift like the block floaters" },
  { key: "imageFloatSize", control: "slider", label: "Image floaters size", min: 0.5, max: 8, step: 0.5, decimals: 1, container: "floatGroup", title: "Largest image floater in units (smallest is half)" },
  { key: "imageFloatTravel", control: "slider", label: "Image floaters travel", min: 0, max: 600, step: 10, decimals: 0, container: "floatGroup", title: "How far a slice is pushed sideways at most, px on the 1080 canvas; the floater itself drifts half that" },
];
const numParams = params as unknown as Record<NumKey, number>;
const stepInputs: Partial<Record<NumKey, HTMLInputElement>> = {};
const sliderSyncs: Partial<Record<NumKey, () => void>> = {};
const stepRows: Record<string, HTMLElement> = {};
const SLIDER_TICKS = 57;

function fmtStep(def: StepDef, v: number) {
  return `${v.toFixed(def.decimals)}${def.suffix ?? ""}`;
}
function syncStep(key: NumKey) {
  const def = stepDefs.find((d) => d.key === key);
  const inp = stepInputs[key];
  if (def && inp) inp.value = fmtStep(def, numParams[key]);
  sliderSyncs[key]?.();
}
/**
 * A slider: a row of ticks, the value's tick dark. Click or drag sets it,
 * arrow keys step it; the label shows the value while the pointer is over
 * the row.
 */
function renderSlider(def: StepDef) {
  const row = document.createElement("div");
  row.className = "row";
  if (def.title) row.title = def.title;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = def.label;
  const slider = document.createElement("div");
  slider.className = "slider";
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  slider.dataset.key = def.key;
  const ticks: HTMLElement[] = [];
  for (let i = 0; i < SLIDER_TICKS; i++) {
    const t = document.createElement("i");
    slider.appendChild(t);
    ticks.push(t);
  }
  row.append(lbl, slider);
  stepRows[def.key] = row;
  let hover = false;
  const sync = () => {
    const v = numParams[def.key];
    const idx = Math.round(((v - def.min) / (def.max - def.min)) * (SLIDER_TICKS - 1));
    ticks.forEach((t, i) => t.classList.toggle("on", i === idx));
    slider.setAttribute("aria-valuenow", String(v));
    lbl.textContent = hover ? fmtStep(def, v) : def.label;
  };
  sliderSyncs[def.key] = sync;
  const set = (v: number) => {
    const snapped = Math.round(v / def.step) * def.step;
    numParams[def.key] = clamp(Math.round(snapped * 1000) / 1000, def.min, def.max);
    sync();
    rebuild();
  };
  const at = (clientX: number) => {
    const r = slider.getBoundingClientRect();
    if (r.width <= 0) return;
    set(def.min + clamp((clientX - r.left) / r.width, 0, 1) * (def.max - def.min));
  };
  let dragging = false;
  slider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    slider.focus({ preventScroll: true });
    at(e.clientX);
  });
  slider.addEventListener("pointermove", (e) => {
    if (dragging) at(e.clientX);
  });
  for (const ev of ["pointerup", "pointercancel"]) slider.addEventListener(ev, () => (dragging = false));
  slider.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    set(numParams[def.key] + dir * def.step * (e.shiftKey ? 10 : 1));
  });
  row.addEventListener("pointerenter", () => {
    hover = true;
    sync();
  });
  row.addEventListener("pointerleave", () => {
    hover = false;
    sync();
  });
  sync();
  const host = $<HTMLDivElement>(def.container);
  const seg = host.querySelector(":scope > .seg");
  if (seg) host.insertBefore(row, seg);
  else host.appendChild(row);
}
function renderStep(def: StepDef) {
  if (def.control === "slider") return renderSlider(def);
  const row = document.createElement("div");
  row.className = "row";
  if (def.title) row.title = def.title;
  row.innerHTML = `
    <span class="lbl">${def.label}</span>
    <div class="stepper">
      <button type="button" class="btn w20" data-dir="-1">–</button>
      <input type="text" class="w45" spellcheck="false" />
      <button type="button" class="btn w20" data-dir="1">+</button>
    </div>`;
  const input = row.querySelector("input") as HTMLInputElement;
  stepInputs[def.key] = input;
  stepRows[def.key] = row;
  input.value = fmtStep(def, numParams[def.key]);
  const set = (v: number) => {
    const snapped = Math.round(v / def.step) * def.step;
    numParams[def.key] = clamp(Math.round(snapped * 1000) / 1000, def.min, def.max);
    input.value = fmtStep(def, numParams[def.key]);
    rebuild();
  };
  for (const b of row.querySelectorAll<HTMLButtonElement>("button")) {
    b.addEventListener("click", (e) => {
      const dir = parseInt(b.dataset.dir ?? "1", 10);
      set(numParams[def.key] + dir * def.step * (e.shiftKey ? 10 : 1));
    });
  }
  const commit = () => {
    const v = parseFloat(input.value.replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(v)) set(v);
    else input.value = fmtStep(def, numParams[def.key]);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? 1 : -1;
      set(numParams[def.key] + dir * def.step * (e.shiftKey ? 10 : 1));
    }
  });
  const host = $<HTMLDivElement>(def.container);
  // keep the stagger-order buttons as the last row of their group
  const seg = host.querySelector(":scope > .seg");
  if (seg) host.insertBefore(row, seg);
  else host.appendChild(row);
}
for (const def of stepDefs) renderStep(def);

// Only the settings that change the picture are shown. One-stage posters
// have static text and no opening: their timing is one Loop length. The
// block row has no hole (so no edge blocks, floaters or shape), no blocks
// means no stripes at all, and the reveal has no title, info or logo.
const ONE_STAGE_OFF: NumKey[] = ["holdClosed", "duration", "holdOpen", "labelTime", "stagger"];
const HIDDEN_STEPS: Record<LayoutKind, NumKey[]> = {
  reveal: ["stripPx", "loopLen"],
  none: [...ONE_STAGE_OFF, "opening", "vignette", "faith", "rowsTop", "rowsBottom", "stripPx", "irregularity", "shapeSeed", "unitPx", "blockWidth", "blockTravel", "blockSeed", "floatCount", "floatSize", "floatTravel", "imageFloatCount", "imageFloatSize", "imageFloatTravel"],
  row: [...ONE_STAGE_OFF, "opening", "vignette", "faith", "irregularity", "shapeSeed", "blockWidth", "floatCount", "floatSize", "floatTravel", "imageFloatCount", "imageFloatSize", "imageFloatTravel"],
  side: [...ONE_STAGE_OFF, "stripPx"],
  full: [...ONE_STAGE_OFF, "stripPx"],
  page: [...ONE_STAGE_OFF, "opening", "vignette", "faith", "irregularity", "shapeSeed", "stripPx", "blockWidth", "floatCount", "floatSize", "floatTravel", "imageFloatCount", "imageFloatSize", "imageFloatTravel"],
};
// Text fields per preset: the artist cards (1, 3) take day, time, artist and
// stage; the info posters (2, 4) a title and the sentence.
const TEXT_ROWS: Record<string, number[]> = {
  titleRow: [2, 4, 5],
  infoRow: [2, 4, 5],
  info2Row: [2, 4, 5],
  info3Row: [2, 4, 5],
  info4Row: [2, 4, 5],
  dayRow: [1, 3],
  timeRow: [1, 3],
  artistRow: [1, 3],
  stageRow: [1, 3],
};
function syncVisibility() {
  const layout = params.layout;
  const hidden = new Set<NumKey>(HIDDEN_STEPS[layout]);
  for (const def of stepDefs) stepRows[def.key].hidden = hidden.has(def.key);
  const oneStage = layout !== "reveal";
  $<HTMLDivElement>("orderSeg").hidden = oneStage; // the stagger order only shapes the reveal
  $<HTMLDivElement>("colorGroup").hidden = layout === "none"; // no stripes, no stripe colours
  $<HTMLElement>("styleGroup").hidden = params.preset !== 5; // rows or full page: the paragraph poster's choice
  setStyleUI(layout === "page" ? "page" : "row");
  for (const [id, presets] of Object.entries(TEXT_ROWS)) $<HTMLElement>(id).hidden = !presets.includes(params.preset);
  if (!TEXT_ROWS.artistRow.includes(params.preset)) artist2Row.hidden = true;
  else artist2Row.hidden = !artist2Shown;
  syncInfoRows();
  // a group with nothing left in it goes too
  for (const id of ["timingGroup", "rowsGroup", "shapeGroup", "blocksGroup", "floatGroup"]) {
    const g = $<HTMLElement>(id);
    g.hidden = Array.from(g.children).every((c) => (c as HTMLElement).hidden);
  }
}

// ---------- text ----------

function bindText(id: string, apply: (v: string) => void) {
  const el = $<HTMLInputElement>(id); // or a textarea: same value / input / focus API
  el.addEventListener("input", () => {
    apply(el.value);
    schedule();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && el.tagName !== "TEXTAREA") el.blur();
  });
  return el;
}
// Title and Info grow with their text: one line is a normal 32 px field,
// two lines the design's 46 px, and 11 px for every further line.
function autosize(el: HTMLInputElement) {
  if (el.parentElement?.classList.contains("para")) {
    // a paragraph field: as tall as its wrapped text (the buttons stretch with it)
    el.style.height = "auto";
    el.style.height = `${Math.max(102, el.scrollHeight)}px`;
    return;
  }
  const btns = el.parentElement?.querySelectorAll<HTMLElement>(".btn.tall") ?? [];
  for (const btn of btns) btn.style.height = "";
  el.style.height = "auto";
  const lines = Math.max(1, Math.round((el.scrollHeight - 12) / 11));
  const h = lines <= 1 ? 32 : 24 + 11 * lines;
  el.style.height = `${h}px`;
  for (const btn of btns) btn.style.height = `${h}px`;
}
const titleEl = bindText("titleText", (v) => (params.title = v));
const dayEl = bindText("dayText", (v) => (params.day = v));
const timeStartEl = bindText("timeStartText", (v) => (params.timeStart = v));
const timeEndEl = bindText("timeEndText", (v) => (params.timeEnd = v));
const artistEl = bindText("artistText", (v) => (params.artist = v));
const stageTextEl = bindText("stageText", (v) => (params.stage = v));
const artist2El = bindText("artist2Text", (v) => (params.artist2 = v));
const infoEl = bindText("infoText", (v) => (params.info = v));
const infoEls: Record<(typeof INFO_KEYS)[number], HTMLInputElement> = {
  info: infoEl,
  info2: bindText("info2Text", (v) => (params.info2 = v)),
  info3: bindText("info3Text", (v) => (params.info3 = v)),
  info4: bindText("info4Text", (v) => (params.info4 = v)),
};
const infoAddBtn = $<HTMLButtonElement>("infoAddBtn");
let infoShown = 1; // how many info rows are open (the first always is)
/** The extra info rows: open ones follow the Info row, + on the last open one. */
function syncInfoRows() {
  const inPreset = TEXT_ROWS.infoRow.includes(params.preset);
  for (let i = 1; i < INFO_KEYS.length; i++) {
    if (params[INFO_KEYS[i]]) infoShown = Math.max(infoShown, i + 1);
    $<HTMLElement>(`${INFO_KEYS[i]}Row`).hidden = !inPreset || i >= infoShown;
  }
  infoAddBtn.hidden = infoShown >= INFO_KEYS.length;
}
infoAddBtn.addEventListener("click", () => {
  if (infoShown >= INFO_KEYS.length) return;
  infoShown++;
  syncInfoRows();
  infoEls[INFO_KEYS[infoShown - 1]].focus();
});
/** Take one info row away: the ones after it move up. */
function removeInfo(key: (typeof INFO_KEYS)[number]) {
  const i = INFO_KEYS.indexOf(key);
  for (let j = Math.max(1, i); j < INFO_KEYS.length; j++) {
    const next = INFO_KEYS[j + 1];
    params[INFO_KEYS[j]] = next ? params[next] : "";
    params[`${INFO_KEYS[j]}Size` as "info2Size"] = next ? params[`${next}Size` as "info2Size"] : 0;
    params[`${INFO_KEYS[j]}W` as "info2W"] = next ? params[`${next}W` as "info2W"] : 0;
    ungroup(INFO_KEYS[j]);
    infoEls[INFO_KEYS[j]].value = params[INFO_KEYS[j]];
    autosize(infoEls[INFO_KEYS[j]]);
  }
  if (i === 0) {
    infoEl.value = params.info = "";
    autosize(infoEl);
  } else infoShown = Math.max(1, infoShown - 1);
  syncInfoRows();
  rebuild();
}
for (const key of INFO_KEYS.slice(1)) $<HTMLButtonElement>(`${key}RemoveBtn`).addEventListener("click", () => removeInfo(key));
// Type size per info block: the letter is the default it is nearest to
// (a click steps S > M > L), – and + change it a pixel (on the 540 px
// design) at a time. The extra blocks follow the first until given their own.
const infoSizeBtns = Object.fromEntries(INFO_KEYS.map((key) => [key, $<HTMLButtonElement>(`${key}SizeBtn`)])) as Record<(typeof INFO_KEYS)[number], HTMLButtonElement>;
function syncInfoSizes() {
  for (const key of INFO_KEYS) {
    const px = infoSizeOf(params, key);
    infoSizeBtns[key].textContent = infoSizeLabel(px).toUpperCase();
    infoSizeBtns[key].title = `${px} px (${px * 2} px at 1080). Click: S ${INFO_SIZES.s}, M ${INFO_SIZES.m}, L ${INFO_SIZES.l}`;
  }
}
function setInfoSize(key: (typeof INFO_KEYS)[number], px: number) {
  const v = clamp(Math.round(px), INFO_SIZE_MIN, INFO_SIZE_MAX);
  if (key === "info") {
    // the extra blocks that were following the first keep the size they show
    for (const o of INFO_KEYS.slice(1)) if (!params[`${o}Size`] && params[o]) params[`${o}Size`] = params.infoSize;
    params.infoSize = v;
  } else params[`${key}Size`] = v;
  syncInfoSizes();
  rebuild();
}
for (const key of INFO_KEYS) {
  infoSizeBtns[key].addEventListener("click", () => {
    const cur = infoSizeLabel(infoSizeOf(params, key));
    setInfoSize(key, INFO_SIZES[cur === "s" ? "m" : cur === "m" ? "l" : "s"]);
  });
  $<HTMLButtonElement>(`${key}SizeDown`).addEventListener("click", () => setInfoSize(key, infoSizeOf(params, key) - 1));
  $<HTMLButtonElement>(`${key}SizeUp`).addEventListener("click", () => setInfoSize(key, infoSizeOf(params, key) + 1));
}

// Background colour (no photo): the four stripe colours and the blocks' yellow.
const BG_KEYS: Exclude<BgColor, "">[] = ["topA", "topB", "bottomA", "bottomB", "labelBg"];
const bgSeg = $<HTMLDivElement>("bgSeg");
const bgBtns = BG_KEYS.map((k) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn";
  b.addEventListener("click", () => {
    params.bgColor = params.bgColor === k ? "" : k;
    syncBg();
    rebuild();
  });
  bgSeg.appendChild(b);
  return b;
});
function syncBg() {
  BG_KEYS.forEach((k, i) => {
    bgBtns[i].style.background = params.colors[k];
    bgBtns[i].classList.toggle("active", params.bgColor === k);
  });
}
// Style (the paragraph poster): strip rows at the edges, or the closed card over the whole page.
const setStyleUI = bindSeg<"row" | "page">("styleSeg", "style", (v) => {
  if (params.layout === v) return;
  params.layout = v;
  // each style has its own sensible rows: two strips per edge, or the closed card's rows
  params.rowsTop = v === "row" ? 2 : DEFAULT_PARAMS.rowsTop;
  params.rowsBottom = v === "row" ? 2 : DEFAULT_PARAMS.rowsBottom;
  syncUI();
  rebuild();
});
const artist2Row = $<HTMLDivElement>("artist2Row");
const artist2AddBtn = $<HTMLButtonElement>("artist2AddBtn");
const artistLbl = $<HTMLSpanElement>("artistLbl");
let artist2Shown = false;
// Two artists at most: the + opens the second field and goes away, the
// field's own button removes it again.
function showArtist2(show: boolean) {
  artist2Shown = show;
  artist2Row.hidden = !show || !TEXT_ROWS.artistRow.includes(params.preset);
  artist2AddBtn.hidden = show;
  artistLbl.textContent = show ? "Artist 1" : "Artist";
}
artist2AddBtn.addEventListener("click", () => {
  showArtist2(true);
  rebuild();
  artist2El.focus();
});
$<HTMLButtonElement>("artist2RemoveBtn").addEventListener("click", () => {
  params.artist2 = "";
  artist2El.value = "";
  showArtist2(false);
  rebuild();
});
// text changes can change the block count, which sets the loop length
for (const el of [titleEl, dayEl, timeStartEl, timeEndEl, artistEl, stageTextEl, artist2El, ...Object.values(infoEls)]) el.addEventListener("input", () => rebuild());
for (const el of [titleEl, artistEl, artist2El, ...Object.values(infoEls)]) el.addEventListener("input", () => autosize(el));
document.fonts.addEventListener("loadingdone", () => schedule());

// ---------- colours ----------

function normalizeHex(input: string): string | null {
  let s = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s.toUpperCase();
  return null;
}
type PairKey = "top" | "bottom";
const pairKeys: Record<PairKey, [keyof Colors, keyof Colors]> = {
  top: ["topA", "topB"],
  bottom: ["bottomA", "bottomB"],
};
const swatches: Partial<Record<keyof Colors, HTMLButtonElement>> = {};
let colorwayEl: HTMLInputElement | null = null;
let hoveredSwatch: keyof Colors | null = null;
let popover: HTMLDivElement | null = null;
let closePopoverListeners: (() => void) | null = null;
function setColor(key: keyof Colors, hex: string) {
  params.colors[key] = hex;
  const sw = swatches[key];
  if (sw) {
    sw.style.background = hex;
    sw.title = hex;
  }
  syncColorway();
  syncBlockRow();
  syncBg();
  schedule();
}
function closePicker() {
  popover?.remove();
  popover = null;
  closePopoverListeners?.();
  closePopoverListeners = null;
}
function openPicker(anchor: HTMLElement, key: keyof Colors) {
  closePicker();
  popover = document.createElement("div");
  popover.className = "color-popover";
  const picker = document.createElement("hex-color-picker") as HexColorPicker;
  picker.color = params.colors[key];
  picker.addEventListener("color-changed", (e: Event) => {
    setColor(key, (e as CustomEvent<{ value: string }>).detail.value.toUpperCase());
  });
  popover.appendChild(picker);
  document.body.appendChild(popover);
  const r = anchor.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(window.innerWidth - 220, r.right + 8))}px`;
  popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 220, r.top))}px`;
  const onDoc = (ev: MouseEvent) => {
    if (popover && !popover.contains(ev.target as Node) && ev.target !== anchor) closePicker();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closePicker();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
  }, 0);
  closePopoverListeners = () => {
    document.removeEventListener("mousedown", onDoc);
    document.removeEventListener("keydown", onKey);
  };
}
const swatchKeys: (keyof Colors)[] = ["topA", "topB", "bottomA", "bottomB"];
function syncColorway() {
  if (!colorwayEl) return;
  const i = colorwayIndex(params.colors);
  colorwayEl.value = i ? String(i) : "\u2013";
}
function applyColorway(i: number) {
  const n = COLORWAYS.length;
  const idx = ((Math.round(i) - 1) % n + n) % n;
  const w = COLORWAYS[idx];
  swatchKeys.forEach((k, j) => setColor(k, w[j]));
}
function stepColorway(dir: 1 | -1) {
  const i = colorwayIndex(params.colors);
  // custom colours: the arrows enter the list at its ends
  applyColorway(i ? i + dir : dir > 0 ? 1 : COLORWAYS.length);
}
/**
 * The Colours row: the colourway arrows and index, the four stripe colours
 * and the text blocks' yellow. A click on a swatch makes it the text
 * blocks' colour, a double click opens the picker, Alt-click copies the hex.
 */
const YELLOW_KEY = "";
function buildColorRow() {
  const host = $<HTMLDivElement>("colorGroup");
  host.innerHTML = "";
  const row = document.createElement("div");
  row.className = "row colours";
  row.innerHTML = `
    <span class="lbl">Colours</span>
    <button type="button" class="btn w20" data-dir="-1" title="Previous colourway">\u2190</button>
    <input type="text" class="w45" id="colorwayIndex" spellcheck="false" title="Colourway 1 to ${COLORWAYS.length}" />
    <div class="swatches">
      ${swatchKeys.map((k) => `<button type="button" class="swatch" data-key="${k}"></button>`).join("")}
      <button type="button" class="swatch" data-key="${YELLOW_KEY}" title="${params.colors.labelBg}"></button>
    </div>
    <button type="button" class="btn w20" data-dir="1" title="Next colourway">\u2192</button>`;
  for (const sw of row.querySelectorAll<HTMLButtonElement>(".swatch")) {
    const key = sw.dataset.key as keyof Colors | typeof YELLOW_KEY;
    if (key) {
      swatches[key] = sw;
      sw.style.background = params.colors[key];
      sw.title = params.colors[key];
    } else {
      sw.style.background = params.colors.labelBg;
    }
    const hexOf = () => (key ? params.colors[key] : params.colors.labelBg);
    let clickTimer = 0;
    sw.addEventListener("click", (e) => {
      window.clearTimeout(clickTimer);
      if (e.altKey) {
        const hex = hexOf();
        navigator.clipboard.writeText(hex).then(
          () => {
            sw.title = `${hex} copied`;
            setTimeout(() => (sw.title = hexOf()), 1200);
          },
          () => prompt("Hex:", hex),
        );
        return;
      }
      clickTimer = window.setTimeout(() => {
        params.blockColor = key as BlockColor;
        syncBlockRow();
        schedule();
      }, 220);
    });
    sw.addEventListener("dblclick", () => {
      window.clearTimeout(clickTimer);
      if (key) openPicker(sw, key);
    });
    if (key) {
      sw.addEventListener("pointerenter", () => (hoveredSwatch = key));
      sw.addEventListener("pointerleave", () => {
        if (hoveredSwatch === key) hoveredSwatch = null;
      });
    }
  }
  for (const b of row.querySelectorAll<HTMLButtonElement>("[data-dir]")) {
    b.addEventListener("click", () => stepColorway(Number(b.dataset.dir) as 1 | -1));
  }
  const el = (colorwayEl = row.querySelector("#colorwayIndex") as HTMLInputElement);
  const commit = () => {
    const n = parseInt(el.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= COLORWAYS.length) applyColorway(n);
    else syncColorway();
  };
  el.addEventListener("change", commit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      el.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      stepColorway(e.key === "ArrowUp" ? 1 : -1);
    }
  });
  host.appendChild(row);
  syncColorway();
  syncBlockRow();
}
/** The swatch of the text blocks' colour is marked. */
function syncBlockRow() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#colorGroup .swatch")) {
    b.classList.toggle("active", (b.dataset.key ?? "") === params.blockColor);
  }
}
buildColorRow();

// Cmd+V over a swatch pastes a hex from the clipboard (with or without #).
// Cmd+V with an image on the clipboard loads it as the background.
document.addEventListener(
  "paste",
  (e) => {
    const data = e.clipboardData;
    if (!data) return;
    if (hoveredSwatch) {
      const hex = normalizeHex(data.getData("text/plain") || "");
      if (hex) {
        e.preventDefault();
        setColor(hoveredSwatch, hex);
        return;
      }
    }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const file = Array.from(data.files ?? []).find((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (file) {
      e.preventDefault();
      loadMediaFile(file);
    }
  },
  true,
);

// ---------- background image ----------

const imageRemoveBtn = $<HTMLButtonElement>("imageRemoveBtn");
let loadGen = 0;
function setImage(next: ImageSource | null) {
  image = next;
  canvas.classList.toggle("empty", !next);
  imageRemoveBtn.disabled = !next;
  schedule();
}
let imageFile: Blob | null = null; // the photo as loaded, for .touquet files
/** A dropped, pasted or picked file: a photo, a video or a saved .touquet. */
function loadMediaFile(file: File) {
  if (/\.touquet$/i.test(file.name)) void loadTouquetFile(file);
  else if (file.type.startsWith("video/")) void loadVideoFile(file);
  else if (file.type.startsWith("image/")) loadImageFile(file);
}
function loadImageFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  clearVideo();
  imageFile = file;
  const gen = ++loadGen;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    if (gen !== loadGen) return; // a newer file won
    params.imageZoom = 1;
    params.imageX = 0;
    params.imageY = 0;
    setImage({ source: img, width: img.naturalWidth, height: img.naturalHeight });
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (gen === loadGen) alert("Could not load that image.");
  };
  img.src = url;
}
$<HTMLButtonElement>("imageLoadBtn").addEventListener("click", () => fileInput.click());
imageRemoveBtn.addEventListener("click", () => {
  loadGen++;
  clearVideo();
  imageFile = null;
  setImage(null);
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f) loadMediaFile(f);
});
for (const ev of ["dragenter", "dragover"]) {
  stageEl.addEventListener(ev, (e) => {
    e.preventDefault();
    stageEl.classList.add("dragover");
  });
}
for (const ev of ["dragleave", "drop"]) {
  stageEl.addEventListener(ev, (e) => {
    e.preventDefault();
    stageEl.classList.remove("dragover");
  });
}
stageEl.addEventListener("drop", (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) loadMediaFile(f);
});

// ---------- video background ----------
// A video (MP4, MOV, WebM; any codec the browser or WebCodecs can decode)
// behind the card instead of a photo. On import it is converted once into
// a uniform in-memory clip (see video.ts); from then on the tool decodes
// the frames itself, driven by the timeline, so playback runs at the
// clip's own frame rate without a <video> element that could stall. The
// piece used is as long as the export; the stepper in the Image row says
// where in the video it starts. Exports read the same frames.
let video: VideoClip | null = null;
let videoStart = 0; // s into the video where the loop starts
const videoStartStepper = $<HTMLDivElement>("videoStartStepper");
const videoStartText = $<HTMLInputElement>("videoStartText");
const imageLoadBtn = $<HTMLButtonElement>("imageLoadBtn");
/** How much of the video one export uses: the export length, or the whole video if that is shorter (it then loops). */
function videoSpan(): number {
  return video ? Math.min(video.duration, exportLength()) : 0;
}
/** The video time for a timeline time: from the start, round the end of the video when the piece runs past it. */
function videoTimeAt(t: number): number {
  const span = videoSpan();
  return span > 0 && video ? (videoStart + (t % span)) % video.duration : 0;
}
/** Show the frame for a video time; `draw` says whether to repaint when it arrives (playback repaints anyway). */
function showVideoFrame(vt: number, redraw: boolean): Promise<void> {
  const v = video;
  if (!v) return Promise.resolve();
  return v.reader.frameAt(vt).then((f) => {
    if (!f || video !== v || !image) return;
    if (image.source !== f.canvas) {
      image.source = f.canvas;
      if (redraw) draw();
    }
  });
}
/** Keep the picture on the timeline: while playing, pick the frame for the current time (skipping a tick if a decode is still running). */
function syncVideo() {
  if (!video) return;
  if (playing && video.reader.busy) return;
  void showVideoFrame(videoTimeAt(time), !playing);
}
const videoBeforeFrame: BeforeFrame = async (t) => {
  if (video) await showVideoFrame(videoTimeAt(t), false);
};
async function loadVideoFile(file: File) {
  const gen = ++loadGen;
  const wasPlaying = playing;
  setPlaying(false);
  imageLoadBtn.disabled = true;
  imageRemoveBtn.disabled = true;
  let clip: VideoClip;
  try {
    clip = await importVideo(file, (f, stage) => {
      if (gen !== loadGen) return;
      imageLoadBtn.textContent = `${stage === "decoding" ? "Reading" : "Converting"} ${Math.round(f * 100)}%`;
    });
  } catch (e) {
    console.error("[video]", e);
    if (gen === loadGen) alert(`Could not read that video (${e instanceof Error ? e.message : e}). An MP4 with H.264 always works.`);
    return;
  } finally {
    imageLoadBtn.textContent = "Load";
    imageLoadBtn.disabled = false;
    imageRemoveBtn.disabled = !image;
  }
  if (gen !== loadGen) {
    clip.reader.close();
    return;
  }
  clearVideo();
  imageFile = null;
  video = clip;
  videoStart = 0;
  params.imageZoom = 1;
  params.imageX = 0;
  params.imageY = 0;
  const first = await clip.reader.frameAt(0);
  if (gen !== loadGen || video !== clip) return;
  const blank = document.createElement("canvas");
  blank.width = clip.width;
  blank.height = clip.height;
  setImage({ source: first?.canvas ?? blank, width: clip.width, height: clip.height });
  videoStartStepper.hidden = false;
  syncVideoStart();
  if (wasPlaying) setPlaying(true);
}
function clearVideo() {
  if (!video) return;
  video.reader.close();
  video = null;
  videoStartStepper.hidden = true;
}
function fmtSeconds(s: number): string {
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}
function syncVideoStart() {
  videoStartText.value = fmtSeconds(videoStart);
}
function setVideoStart(s: number) {
  if (!video) return;
  videoStart = clamp(Math.round(s * 10) / 10, 0, Math.max(0, Math.floor((video.duration - 0.1) * 10) / 10));
  syncVideoStart();
  syncVideo();
}
for (const b of videoStartStepper.querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", (e) => {
    const dir = parseInt(b.dataset.dir ?? "1", 10);
    setVideoStart(videoStart + dir * (e.shiftKey ? 10 : 1));
  });
}
{
  const commit = () => {
    const v = parseFloat(videoStartText.value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(v)) setVideoStart(v);
    else syncVideoStart();
  };
  videoStartText.addEventListener("change", commit);
  videoStartText.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      videoStartText.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setVideoStart(videoStart + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
  });
}

// ---------- .touquet files ----------
// Everything in one JSON file: the settings and the photo or video and
// the music as base64, so a card can be picked up again later or elsewhere.
const touquetInput = $<HTMLInputElement>("touquetInput");
let docName = ""; // the name of the last saved or opened file
interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function blobEntry(blob: Blob | null, name: string): Promise<{ name: string; type: string; data: string } | null> {
  if (!blob) return null;
  return { name, type: blob.type, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
}
/**
 * Save as a .touquet: the browser's own save dialog where there is one
 * (Chrome, Edge), elsewhere a prompt for the name and a download.
 */
/** The whole card as the .touquet document: settings, photo or video, music. */
async function touquetDoc(name: string) {
  let photo = imageFile;
  if (!photo && image && !video) {
    // a preset photo: fetch it as it is served
    try {
      photo = await (await fetch(presetPhoto(params.preset))).blob();
    } catch {
      photo = null;
    }
  }
  return {
    v: 1,
    app: "touquet-artist-card",
    name,
    params,
    image: video ? null : await blobEntry(photo, "photo"),
    video: video ? await blobEntry(video.file, video.file.name) : null,
    videoStart,
    audio: audio ? { name: audio.name, type: "audio/mpeg", data: bytesToBase64(new Uint8Array(audio.bytes)) } : null,
    audioStart,
  };
}
async function saveTouquet() {
  const suggested = docName || PRESET_NAMES[params.preset] || "card";
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  let handle: FileSystemFileHandle | null = null;
  let name = suggested;
  if (picker) {
    try {
      handle = await picker.call(window, {
        suggestedName: `${suggested}.touquet`,
        types: [{ description: "Touquet card", accept: { "application/json": [".touquet"] } }],
      });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      handle = null;
    }
    if (handle) name = handle.name.replace(/\.touquet$/i, "");
  }
  if (!handle) {
    const typed = prompt("Save as:", suggested);
    if (typed === null) return;
    name = typed.trim().replace(/\.touquet$/i, "") || suggested;
  }
  docName = name;
  const doc = await touquetDoc(name);
  const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[/\\:]/g, "-")}.touquet`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
/**
 * Figma's plugin window has no video encoder (its sandbox leaves the page
 * without a secure context): save the card and open the tool in the
 * browser, where the MP4 is made. A browser that gives us the new window
 * gets the card posted straight into it.
 */
const SITE_URL = "https://typograaf.github.io/artist-card/";
async function exportInBrowser() {
  const doc = await touquetDoc(docName || PRESET_NAMES[params.preset] || "card");
  const name = `${doc.name.replace(/[/\\:]/g, "-")}.touquet`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc)], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  const h = serializeHash();
  const win = window.open(h ? `${SITE_URL}#${h}` : SITE_URL, "_blank");
  if (win) {
    // the tool in that window asks for the card once it is ready
    const give = (e: MessageEvent) => {
      if (e.source === win && e.data?.type === "artist-card-ready") {
        win.postMessage({ type: "artist-card-open", doc }, "*");
        window.removeEventListener("message", give);
      }
    };
    window.addEventListener("message", give);
  }
  alert(
    `Figma's plugin window cannot encode video, so the MP4 is made in your browser.\n\nThe card was saved as "${name}"` +
      (win ? " and the tool opened in a new window: drop the file on the preview there if it has not loaded, then press Export MP4." : `. Open ${SITE_URL} in your browser, drop the file on the preview and press Export MP4.`),
  );
}
// a card handed over by the plugin window (see exportInBrowser)
if (window.opener) {
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.type === "artist-card-open" && d.doc && typeof d.doc === "object") {
      void loadTouquetFile(new File([JSON.stringify(d.doc)], `${d.doc.name || "card"}.touquet`, { type: "application/json" }));
    }
  });
  try {
    (window.opener as Window).postMessage({ type: "artist-card-ready" }, "*");
  } catch {
    // an opener from another app
  }
}
async function loadTouquetFile(file: File) {
  let doc: {
    name?: string;
    params?: unknown;
    image?: { name: string; type: string; data: string } | null;
    video?: { name: string; type: string; data: string } | null;
    videoStart?: number;
    audio?: { name: string; type: string; data: string } | null;
    audioStart?: number;
  };
  try {
    doc = JSON.parse(await file.text());
    if (!doc || typeof doc !== "object" || !doc.params) throw new Error("not a card");
  } catch {
    alert("That is not a .touquet file.");
    return;
  }
  docName = doc.name || file.name.replace(/\.touquet$/i, "");
  applySettings(JSON.stringify(doc.params));
  applyFormat();
  rebuild();
  if (doc.video) {
    await loadVideoFile(new File([base64ToBytes(doc.video.data) as BlobPart], doc.video.name, { type: doc.video.type }));
    setVideoStart(doc.videoStart ?? 0);
  } else if (doc.image) {
    loadImageFile(new File([base64ToBytes(doc.image.data) as BlobPart], doc.image.name, { type: doc.image.type }));
  } else {
    loadGen++;
    clearVideo();
    imageFile = null;
    setImage(null);
  }
  if (doc.audio) {
    await loadAudio(new File([base64ToBytes(doc.audio.data) as BlobPart], doc.audio.name, { type: doc.audio.type }));
    setAudioStart(doc.audioStart ?? 0);
  } else {
    stopAudio();
    audio = null;
    waveEl.hidden = true;
    audioRemoveBtn.disabled = true;
  }
  syncUI();
}
$<HTMLButtonElement>("saveBtn").addEventListener("click", () => void saveTouquet().catch((e) => alert(`Could not save: ${e}`)));
$<HTMLButtonElement>("loadBtn").addEventListener("click", () => touquetInput.click());
touquetInput.addEventListener("change", () => {
  const f = touquetInput.files?.[0];
  touquetInput.value = "";
  if (f) void loadTouquetFile(f);
});

// ---------- on-canvas interaction ----------
// Drag the artist group up or down; drag anywhere else to reposition the
// photo; a plain click on an empty card opens the file picker.

function canvasPoint(e: PointerEvent | WheelEvent): { x: number; y: number; k: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return null;
  const k = canvas.width / rect.width; // canvas px per css px
  return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k, k };
}
function overArtist(x: number, y: number): boolean {
  const r = layout.artistRect;
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
type DragMode = "none" | "label" | "pan" | "falloff" | "block" | "stack" | "group" | "resize";
let drag: DragMode = "none";
let dragMoved = false;
let emptyDown = false; // the last press landed on nothing draggable
let lastX = 0;
let lastY = 0;
// One-stage layouts: every block row can be dragged up or down (rows are
// always centred). Inside the stack it reorders (rows snap to the fixed
// gap), pulled out above or below the stack it detaches and sits at its own
// height, brought back near the stack it snaps in again. Shift-drag, on any
// block or anywhere on the stack, moves the whole attached collection.
let dragKey: StackKey | null = null;
let grabDY = 0; // pointer minus block centre at grab time (canvas px)
const DETACH = 40; // css px
function blockAt(x: number, y: number): StackKey | null {
  if (params.layout === "reveal") return null;
  // what is drawn last is on top: free blocks over the stack, later rows over earlier ones
  const present = [...params.stack, ...STACK_KEYS.filter((k) => !params.stack.includes(k))].filter((k) => layout.blocks[k]);
  const drawn = [...present.filter((k) => params.free[k] === undefined), ...present.filter((k) => params.free[k] !== undefined)];
  for (const key of drawn.reverse()) {
    const r = layout.blocks[key]!;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return key;
  }
  return null;
}
/**
 * The info block whose left or right edge is under the pointer: dragging
 * that edge sets how wide the text may run before it wraps (the block
 * stays centred, so both edges move). Double-click = back to the default.
 */
function infoEdgeAt(x: number, y: number, k: number): (typeof INFO_KEYS)[number] | null {
  if (params.layout === "reveal") return null;
  const reach = 8 * k;
  for (const key of INFO_KEYS) {
    const r = layout.blocks[key];
    if (!r || y < r.y || y > r.y + r.h) continue;
    if (Math.abs(x - r.x) <= reach || Math.abs(x - (r.x + r.w)) <= reach) return key;
  }
  return null;
}
// The info block under the pointer (or being resized) shows a grip on each
// side edge, so it is clear the edges can be dragged.
let gripKey: (typeof INFO_KEYS)[number] | null = null;
let gripHot = false; // the pointer is on an edge, or dragging it
function setGrip(key: (typeof INFO_KEYS)[number] | null, hot: boolean) {
  if (key === gripKey && hot === gripHot) return;
  gripKey = key;
  gripHot = hot;
  schedule();
}
function drawResizeHandles() {
  const r = gripKey && layout.blocks[gripKey];
  if (!r || playing) return;
  const rect = canvas.getBoundingClientRect();
  const k = rect.width ? canvas.width / rect.width : 2;
  const gh = Math.min(r.h - 6 * k, 28 * k); // grip height
  const gw = 6 * k;
  const cy = r.y + r.h / 2;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (gripHot) {
    // the edges themselves light up while one is held or about to be
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(r.x - 1.5 * k, r.y, 3 * k, r.h);
    ctx.fillRect(r.x + r.w - 1.5 * k, r.y, 3 * k, r.h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(r.x - 0.5 * k, r.y, k, r.h);
    ctx.fillRect(r.x + r.w - 0.5 * k, r.y, k, r.h);
  }
  for (const x of [r.x, r.x + r.w]) {
    ctx.beginPath();
    ctx.roundRect(x - gw / 2, cy - gh / 2, gw, gh, gw / 2);
    ctx.fillStyle = gripHot ? "#ffffff" : "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.lineWidth = k;
    ctx.strokeStyle = "#737373";
    ctx.stroke();
  }
  ctx.restore();
}
function resizeInfo(key: (typeof INFO_KEYS)[number], x: number) {
  const W = canvas.width;
  params[key === "info" ? "infoW" : (`${key}W` as "info2W")] = clamp((2 * Math.abs(x - W / 2)) / W, 0.1, 1);
  schedule();
}
function stackedKeys(): StackKey[] {
  // the same order the engine draws in: blocks missing from params.stack (an
  // older link, a block added later such as Info 2) come after it
  const order = [...params.stack, ...STACK_KEYS.filter((k) => !params.stack.includes(k))];
  return order.filter((k) => layout.blocks[k] && params.free[k] === undefined);
}
function overStack(x: number, y: number): boolean {
  const r = layout.stackRect;
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
/** Union of the rects of the stacked blocks other than `key` (null when none). */
function othersRect(key: StackKey): Rect | null {
  let r: Rect | null = null;
  for (const o of stackedKeys()) {
    if (o === key) continue;
    const b = layout.blocks[o]!;
    r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), w: 0, h: Math.max(r.y + r.h, b.y + b.h) - Math.min(r.y, b.y) } : { ...b };
  }
  return r;
}
/** Vertical distance between a block spanning y0..y1 and a rect (0 when they overlap). */
function gapTo(y0: number, y1: number, r: Rect): number {
  return Math.max(0, r.y - y1, y0 - (r.y + r.h));
}
/**
 * Put the stack so its top edge is at `top` given its height `h`, whichever
 * side it is anchored on. Used whenever a block joins or leaves at one end,
 * so the blocks that stay do not move: if they did, the distance the
 * attach/detach test measures would jump and the block would flicker in and
 * out of the stack.
 */
function pinStack(top: number, h: number) {
  params.stackY = clamp((params.stackAnchor === "top" ? top : top + h) / canvas.height, 0, 1);
}
/** Where `cy` falls among the stacked blocks other than `key`: above them all, below them all, or between. */
function sideOf(key: StackKey, cy: number): "above" | "below" | "between" {
  const centres = stackedKeys()
    .filter((o) => o !== key)
    .map((o) => layout.blocks[o]!.y + layout.blocks[o]!.h / 2);
  if (centres.every((c) => cy < c)) return "above";
  if (centres.every((c) => cy >= c)) return "below";
  return "between";
}
/** The free group `key` is in, top to bottom (just itself when it is on its own). */
function freeGroupOf(key: StackKey): StackKey[] {
  return freeGroups(params, (k) => !!layout.blocks[k]).find((g) => g.includes(key)) ?? [key];
}
function rectOf(keys: StackKey[]): Rect {
  const y = Math.min(...keys.map((o) => layout.blocks[o]!.y));
  const b = Math.max(...keys.map((o) => layout.blocks[o]!.y + layout.blocks[o]!.h));
  return { x: 0, y, w: 0, h: b - y };
}
function heightOfKeys(keys: StackKey[]): number {
  return keys.reduce((a, o) => a + layout.blocks[o]!.h, 0) + LABEL_GAP * scene.S * (keys.length - 1);
}
/** Take `keys` out of every free group (their free values are left alone). */
function stripGroups(keys: StackKey[]) {
  params.groups = params.groups
    .split(";")
    .map((g) => g.split("+").filter((k) => k && !keys.includes(k as StackKey)))
    .filter((g) => g.length > 1)
    .map((g) => g.join("+"))
    .join(";");
}
/** A block that stops being free: out of its group and back in the stack. */
function ungroup(key: StackKey) {
  delete params.free[key];
  stripGroups([key]);
}
/** Make `keys` (top to bottom) one free group with its top edge at `top`; one key = a free block on its own. */
function setGroup(keys: StackKey[], top: number) {
  stripGroups(keys);
  const v = clamp((top + heightOfKeys(keys) / 2) / canvas.height, 0, 1);
  for (const o of keys) params.free[o] = v;
  if (keys.length > 1) params.groups = [params.groups, keys.join("+")].filter(Boolean).join(";");
}
/** `key` at centre `cy` sorted in among `mates` by their centres. */
function orderWith(mates: StackKey[], key: StackKey, cy: number): StackKey[] {
  return [...mates.map((o) => ({ o, y: layout.blocks[o]!.y + layout.blocks[o]!.h / 2 })), { o: key, y: cy }].sort((a, b) => a.y - b.y).map((e) => e.o);
}
/** The free block nearest to the span y0..y1, within reach (null when none). */
function nearestFree(key: StackKey, y0: number, y1: number, reach: number): StackKey | null {
  let best: StackKey | null = null;
  let bestD = reach;
  for (const o of STACK_KEYS) {
    const ro = layout.blocks[o];
    if (o === key || params.free[o] === undefined || !ro) continue;
    const d = gapTo(y0, y1, ro);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}
function dragBlock(py: number, k: number) {
  const key = dragKey!;
  const H = canvas.height;
  const gap = LABEL_GAP * scene.S;
  const cyB = py - grabDY;
  const me = layout.blocks[key]!;
  const y0 = cyB - me.h / 2;
  const y1 = cyB + me.h / 2;
  const near = (DETACH / 2) * k;
  const isFree = params.free[key] !== undefined;
  const mates = isFree ? freeGroupOf(key).filter((o) => o !== key) : [];
  const sr = othersRect(key);
  if (mates.length) {
    // in a free group: it behaves like the stack. Reorder inside it, leave
    // it when pulled clear; the blocks that stay keep their place
    const gr = rectOf(mates);
    if (gapTo(y0, y1, gr) > DETACH * k) {
      setGroup(mates, gr.y);
      setGroup([key], y0);
    } else {
      const all = orderWith(mates, key, cyB);
      // around the group's own centre, so nothing drifts while reordering
      setGroup(all, params.free[mates[0]]! * H - heightOfKeys(all) / 2);
    }
  } else if (!isFree && !sr) {
    // nothing else in the stack: this block is the stack, so dragging it
    // moves the stack itself (keeps it a stack for others to snap into)
    pinStack(y0, me.h);
    // a free block or group it is brought up against joins it, staying where it is
    const o = nearestFree(key, y0, y1, near);
    if (o) {
      const grp = freeGroupOf(o);
      const gr = rectOf(grp);
      for (const m of grp) ungroup(m);
      const above = cyB < gr.y + gr.h / 2;
      pinStack(above ? gr.y - gap - me.h : gr.y, me.h + gap + gr.h);
      const mine = above ? [key, ...grp] : [...grp, key];
      params.stack = [...mine, ...params.stack.filter((s) => !mine.includes(s))];
    }
  } else if (isFree) {
    const o = nearestFree(key, y0, y1, near);
    const dStack = sr ? gapTo(y0, y1, sr) : Infinity;
    const dFree = o ? gapTo(y0, y1, layout.blocks[o]!) : Infinity;
    if (sr && dStack < near && dStack <= dFree) {
      // back against the stack: snap in at the row under the pointer
      const side = sideOf(key, cyB);
      ungroup(key);
      reorderTo(key, cyB);
      // joining at an end: the others keep their place, the stack grows towards the block
      if (side === "above") pinStack(sr.y - gap - me.h, sr.h + gap + me.h);
      else if (side === "below") pinStack(sr.y, sr.h + gap + me.h);
    } else if (o) {
      // against another free block: the two (or its whole group) become a group
      const grp = freeGroupOf(o);
      const gr = rectOf(grp);
      const all = orderWith(grp, key, cyB);
      const i = all.indexOf(key);
      // at an end the group keeps its place and grows towards the block
      setGroup(all, i === 0 ? gr.y - gap - me.h : i === all.length - 1 ? gr.y : gr.y - (me.h + gap) / 2);
    } else setGroup([key], y0);
  } else {
    // pulled clear of the other blocks: detach and sit at its own height
    if (gapTo(y0, y1, sr!) > DETACH * k) {
      setGroup([key], y0);
      // the others keep their place when an end block leaves
      if (me.y < sr!.y || me.y + me.h > sr!.y + sr!.h) pinStack(sr!.y, sr!.h);
    } else reorderTo(key, cyB);
  }
  schedule();
}
function clearBlock(key: StackKey) {
  if (key === "title") titleEl.value = params.title = "";
  else if (key === "day") dayEl.value = params.day = "";
  else if (key === "time") timeStartEl.value = timeEndEl.value = params.timeStart = params.timeEnd = "";
  else if (key === "artist") {
    artistEl.value = params.artist = "";
    artist2El.value = params.artist2 = "";
    showArtist2(false);
  } else if (key === "stage") stageTextEl.value = params.stage = "";
  else if (key === "icon") {
    params.logo = "off";
    syncLayoutUI();
  } else if (isInfoKey(key)) removeInfo(key);
  ungroup(key);
  drag = "none";
  dragKey = null;
  canvas.classList.remove("block-drag", "block-hover");
  rebuild();
}
function reorderTo(key: StackKey, cy: number) {
  const others = stackedKeys().filter((k) => k !== key);
  const centreOf = (k: StackKey) => {
    const r = layout.blocks[k]!;
    return r.y + r.h / 2;
  };
  const sorted = [...others.map((k) => ({ k, y: centreOf(k) })), { k: key, y: cy }].sort((a, b) => a.y - b.y).map((o) => o.k);
  const rest = params.stack.filter((k) => !sorted.includes(k));
  params.stack = [...sorted, ...STACK_KEYS.filter((k) => rest.includes(k))];
}
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const pt = canvasPoint(e);
  if (!pt) return;
  const wasSelected = falloffSelected;
  falloffSelected = overFalloff(pt.x, pt.y, pt.k);
  const edgeKey = falloffSelected ? null : infoEdgeAt(pt.x, pt.y, pt.k);
  dragKey = falloffSelected ? null : (edgeKey ?? blockAt(pt.x, pt.y));
  if (edgeKey) {
    drag = "resize";
    canvas.classList.add("resize-drag");
    setGrip(edgeKey, true);
  } else if (dragKey) {
    const r = layout.blocks[dragKey]!;
    grabDY = pt.y - (r.y + r.h / 2);
    drag = !e.shiftKey ? "block" : params.free[dragKey] !== undefined ? "group" : "stack";
    canvas.classList.add("block-drag");
  } else if (e.shiftKey && !falloffSelected && overStack(pt.x, pt.y)) {
    drag = "stack";
    canvas.classList.add("block-drag");
  } else drag = falloffSelected ? "falloff" : overArtist(pt.x, pt.y) ? "label" : image ? "pan" : "none";
  if (wasSelected !== falloffSelected) schedule();
  emptyDown = drag === "none" && !falloffSelected;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  if (drag !== "none") canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const pt = canvasPoint(e);
  if (!pt) return;
  if (drag === "none") {
    const overF = overFalloff(pt.x, pt.y, pt.k);
    const edge = overF ? null : infoEdgeAt(pt.x, pt.y, pt.k);
    const overE = !!edge;
    canvas.classList.toggle("resize-hover", overE);
    const under = overF || overE ? null : blockAt(pt.x, pt.y);
    setGrip(edge ?? (under && isInfoKey(under) ? under : null), overE);
    const overB = !!under;
    const over = !overF && !overB && overArtist(pt.x, pt.y);
    canvas.classList.toggle("falloff-hover", overF);
    canvas.classList.toggle("block-hover", overB);
    canvas.classList.toggle("label-hover", over);
    canvas.classList.toggle("pan", !overF && !overB && !over && !!image);
    return;
  }
  const dx = (e.clientX - lastX) * pt.k;
  const dy = (e.clientY - lastY) * pt.k;
  if (!dragMoved && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 2) return;
  dragMoved = true;
  lastX = e.clientX;
  lastY = e.clientY;
  if (drag === "resize") {
    resizeInfo(dragKey as (typeof INFO_KEYS)[number], pt.x);
    return;
  } else if (drag === "block") {
    dragBlock(pt.y, pt.k);
    return;
  } else if (drag === "group") {
    // Shift on a free block: the block, or the group it is snapped into, moves as one
    const members = freeGroupOf(dragKey!);
    const v = clamp(params.free[members[0]]! + dy / canvas.height, 0, 1);
    for (const m of members) params.free[m] = v;
    schedule();
    return;
  } else if (drag === "stack") {
    // keep the edge inside the range the stack can actually reach, so a drag
    // against the card's edge does not build up a dead zone on the way back
    const sh = layout.stackRect?.h ?? 0;
    const H = canvas.height;
    const lo = params.stackAnchor === "top" ? 0 : Math.min(1, sh / H);
    const hi = params.stackAnchor === "top" ? Math.max(0, 1 - sh / H) : 1;
    params.stackY = clamp(params.stackY + dy / H, lo, hi);
    schedule();
    return;
  } else if (drag === "falloff") {
    params.falloffX = clamp(params.falloffX + dx / canvas.width, 0, 1);
    params.falloffY = clamp(params.falloffY + dy / canvas.height, 0, 1);
    if (e.shiftKey) {
      // Shift: snap to the vertical or horizontal centre line when close
      const snap = 12 * pt.k;
      if (Math.abs(params.falloffX * canvas.width - canvas.width / 2) < snap) params.falloffX = 0.5;
      if (Math.abs(params.falloffY * canvas.height - canvas.height / 2) < snap) params.falloffY = 0.5;
    }
    rebuild();
    return;
  } else if (drag === "label") {
    params.labelY = clamp(params.labelY + dy / canvas.height, 0, 1);
  } else if (image) {
    canvas.classList.add("panning");
    const W = canvas.width;
    const H = canvas.height;
    const c = coverRect(image, W, H, params.imageZoom, 0, 0);
    if (c.dw - W > 1) params.imageX = clamp(params.imageX - dx / ((c.dw - W) / 2), -1, 1);
    if (c.dh - H > 1) params.imageY = clamp(params.imageY - dy / ((c.dh - H) / 2), -1, 1);
  }
  schedule();
});
for (const ev of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(ev, () => {
    canvas.classList.remove("panning", "block-drag", "resize-drag");
    if (drag === "resize") setGrip(gripKey, false);
    drag = "none";
    dragKey = null;
  });
}
canvas.addEventListener("dblclick", (e) => {
  const pt = canvasPoint(e as PointerEvent);
  const key = pt && infoEdgeAt(pt.x, pt.y, pt.k);
  if (!key) return;
  params[key === "info" ? "infoW" : (`${key}W` as "info2W")] = 0;
  schedule();
});
canvas.addEventListener("pointerleave", () => {
  if (drag !== "resize") setGrip(null, false);
  canvas.classList.remove("label-hover", "pan", "falloff-hover", "block-hover");
});

// The falloff handle: a small circle at the falloff centre, drag it to move
// the falloff; while it is selected, scrolling over the card resizes the
// falloff circle (shown as a thin outline) instead of zooming the photo.
let falloffSelected = false;
const HANDLE_R = 6; // css px
// the falloff shapes the hole, so it only exists where there is one
function falloffActive(): boolean {
  return params.layout === "reveal" || params.layout === "side" || params.layout === "full";
}
function overFalloff(x: number, y: number, k: number): boolean {
  if (!falloffActive()) return false;
  return Math.hypot(x - params.falloffX * canvas.width, y - params.falloffY * canvas.height) <= (HANDLE_R + 4) * k;
}
function drawFalloffHandle() {
  if (!falloffActive()) return;
  const rect = canvas.getBoundingClientRect();
  const k = rect.width ? canvas.width / rect.width : 2;
  const x = params.falloffX * canvas.width;
  const y = params.falloffY * canvas.height;
  ctx.save();
  ctx.lineWidth = k;
  if (falloffSelected) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, params.falloffR * scene.S), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 3 * k;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = k;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, HANDLE_R * k, 0, Math.PI * 2);
  ctx.fillStyle = falloffSelected ? "#ffffff" : "rgba(255,255,255,0.85)";
  ctx.fill();
  ctx.strokeStyle = "#737373";
  ctx.stroke();
  ctx.restore();
}
canvas.addEventListener("click", () => {
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  // an empty card opens the file picker, but not when the press was on a block or a handle
  if (!image && emptyDown) fileInput.click();
});

// ---------- music ----------
// An MP3 for the video. The strip above the card shows the part of the
// track the loop uses: first bar = where the music starts, last bar = where
// the loop ends. Dragging the strip drags the waveform itself: the grabbed
// point sticks to the cursor, so moving left scrubs the music forward. The
// export copies the MP3 frames from that point (no fade).

const audioInput = $<HTMLInputElement>("audioInput");
const audioRemoveBtn = $<HTMLButtonElement>("audioRemoveBtn");
const waveEl = $<HTMLDivElement>("wave");
const waveTimeEl = $<HTMLButtonElement>("waveTime");
const waveTicksEl = $<HTMLDivElement>("waveTicks");
let audio: AudioTrack | null = null;
let audioStart = 0; // s into the track where the loop starts
let waveBars: HTMLElement[] = [];
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}
function buildWave() {
  if (!audio) return;
  const n = Math.max(2, ticksWidth > 0 ? Math.floor((ticksWidth + 2.5) / 5.5) : 90);
  if (n !== waveBars.length) {
    waveTicksEl.innerHTML = "";
    waveBars = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement("i");
      waveTicksEl.appendChild(el);
      waveBars.push(el);
    }
    waveHead = -1;
  }
  syncWave();
}
function syncWave() {
  if (!audio) return;
  const peaks = windowPeaks(audio, audioStart, exportLength(), waveBars.length);
  waveBars.forEach((el, i) => {
    el.style.height = `${Math.round(4 + 24 * peaks[i])}px`;
  });
  waveTimeEl.textContent = fmtTime(audioStart);
  syncWaveHead();
}
// the playhead on the music strip: the bar under the current time, like the timeline's tick
let waveHead = -1;
function syncWaveHead() {
  if (!audio || !waveBars.length) return;
  const total = exportLength();
  const idx = total > 0 ? clamp(Math.floor((time / total) * waveBars.length), 0, waveBars.length - 1) : 0;
  if (idx === waveHead) return;
  waveBars[waveHead]?.classList.remove("on");
  waveBars[idx]?.classList.add("on");
  waveHead = idx;
}
function setAudioStart(s: number) {
  if (!audio) return;
  audioStart = clamp(s, 0, Math.max(0, audio.duration - exportLength()));
  syncWave();
  if (playing) playAudio(audio, audioStart + time);
}
async function loadAudio(file: File) {
  try {
    audio = await loadAudioFile(file);
  } catch (e) {
    console.error("[audio]", e);
    alert("That file could not be decoded. Use an MP3.");
    return;
  }
  audioStart = 0;
  waveEl.hidden = false;
  audioRemoveBtn.disabled = false;
  buildWave();
  if (playing) playAudio(audio, audioStart + time);
}
$<HTMLButtonElement>("audioLoadBtn").addEventListener("click", () => audioInput.click());
audioInput.addEventListener("change", () => {
  const f = audioInput.files?.[0];
  if (f) void loadAudio(f);
  audioInput.value = "";
});
audioRemoveBtn.addEventListener("click", () => {
  stopAudio();
  audio = null;
  waveEl.hidden = true;
  audioRemoveBtn.disabled = true;
});
let waveDrag = false;
let waveX0 = 0;
let waveStart0 = 0;
function waveDragTo(e: PointerEvent) {
  if (!audio) return;
  const r = waveTicksEl.getBoundingClientRect();
  if (r.width <= 0) return;
  setAudioStart(waveStart0 - ((e.clientX - waveX0) / r.width) * exportLength());
}
waveTicksEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  waveDrag = true;
  waveX0 = e.clientX;
  waveStart0 = audioStart;
  waveTicksEl.setPointerCapture(e.pointerId);
});
waveTicksEl.addEventListener("pointermove", (e) => {
  if (waveDrag) waveDragTo(e);
});
for (const ev of ["pointerup", "pointercancel"]) waveTicksEl.addEventListener(ev, () => (waveDrag = false));

// Scroll over the card: zoom the photo about the pointer.
// Scroll elsewhere in the preview: resize the preview.
let previewScale = 1;
function zoomImageAt(x: number, y: number, factor: number) {
  if (!image) return;
  const W = canvas.width;
  const H = canvas.height;
  const before = coverRect(image, W, H, params.imageZoom, params.imageX, params.imageY);
  const ix = (x - before.x) / before.dw; // image-relative point under the pointer
  const iy = (y - before.y) / before.dh;
  const zoom = clamp(params.imageZoom * factor, 1, 6);
  const after = coverRect(image, W, H, zoom, 0, 0);
  // place the image so that point stays under the pointer, then clamp
  const nx = x - ix * after.dw;
  const ny = y - iy * after.dh;
  params.imageZoom = zoom;
  params.imageX = after.dw - W > 1 ? clamp(((W - after.dw) / 2 - nx) / ((after.dw - W) / 2), -1, 1) : 0;
  params.imageY = after.dh - H > 1 ? clamp(((H - after.dh) / 2 - ny) / ((after.dh - H) / 2), -1, 1) : 0;
  schedule();
}
previewEl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const overCanvas = e.target === canvas;
    if (overCanvas && falloffSelected) {
      params.falloffR = clamp(params.falloffR * Math.exp(-e.deltaY * 0.002), 0.05, 4);
      rebuild();
      return;
    }
    if (overCanvas && image) {
      const pt = canvasPoint(e);
      if (pt) zoomImageAt(pt.x, pt.y, Math.exp(-e.deltaY * 0.002));
      return;
    }
    const next = clamp(previewScale - e.deltaY * 0.002, 0.1, 1);
    if (next === previewScale) return;
    previewScale = next;
    canvas.style.setProperty("--preview-scale", String(previewScale));
  },
  { passive: false },
);

// ---------- settings copy / paste ----------

function flash(btn: HTMLButtonElement, msg: string, ms = 900) {
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = orig), ms);
}
function applySettings(str: string): boolean {
  let obj: Partial<Record<keyof Params, unknown>>;
  try {
    obj = JSON.parse(str.trim());
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let applied = 0;
  for (const def of stepDefs) {
    const v = obj[def.key];
    if (typeof v === "number" && Number.isFinite(v)) {
      numParams[def.key] = clamp(v, def.min, def.max);
      applied++;
    }
  }
  if (typeof obj.format === "string" && Object.hasOwn(FORMATS, obj.format)) {
    params.format = obj.format as Format;
    applied++;
  }
  if (obj.focus === "top" || obj.focus === "bottom") {
    params.focus = obj.focus;
    applied++;
  }
  if (obj.staggerOrder === "center" || obj.staggerOrder === "top" || obj.staggerOrder === "bottom") {
    params.staggerOrder = obj.staggerOrder;
    applied++;
  }
  for (const k of ["imageX", "imageY"] as const) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      params[k] = clamp(v, -1, 1);
      applied++;
    }
  }
  for (const k of ["falloffX", "falloffY", "labelY"] as const) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      params[k] = clamp(v, 0, 1);
      applied++;
    }
  }
  if (typeof obj.falloffR === "number" && Number.isFinite(obj.falloffR)) {
    params.falloffR = clamp(obj.falloffR, 0.05, 4);
    applied++;
  }
  if (typeof obj.imageZoom === "number" && Number.isFinite(obj.imageZoom)) {
    params.imageZoom = clamp(obj.imageZoom, 1, 6);
    applied++;
  }
  if (
    Array.isArray(obj.easing) &&
    obj.easing.length === 4 &&
    obj.easing.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    params.easing = (obj.easing as number[]).map((x) => clamp(x, 0, 1)) as [number, number, number, number];
    applied++;
  }
  if (typeof obj.labelY === "number" && Number.isFinite(obj.labelY)) {
    params.labelY = clamp(obj.labelY, 0, 1);
    applied++;
  }
  if (obj.stackAnchor === "top" || obj.stackAnchor === "bottom") {
    params.stackAnchor = obj.stackAnchor;
    applied++;
  }
  // sizes: px on the 540 px design; older links and files say "s" / "m"
  const sizeOf = (v: unknown): number | null =>
    v === "s" || v === "m" || v === "l" ? INFO_SIZES[v] : typeof v === "number" && Number.isFinite(v) ? v : null;
  for (const k of ["infoSize", "info2Size", "info3Size", "info4Size"] as const) {
    const v = obj[k] === "" ? 0 : sizeOf(obj[k]);
    if (v === null) continue;
    params[k] = v === 0 && k !== "infoSize" ? 0 : clamp(Math.round(v), INFO_SIZE_MIN, INFO_SIZE_MAX);
    applied++;
  }
  for (const k of ["infoW", "info2W", "info3W", "info4W"] as const) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      params[k] = clamp(v, 0, 1);
      applied++;
    }
  }
  if (obj.bgColor === "" || (typeof obj.bgColor === "string" && (BG_KEYS as string[]).includes(obj.bgColor))) {
    params.bgColor = obj.bgColor as BgColor;
    applied++;
  }
  if (typeof obj.preset === "number" && obj.preset >= 1 && obj.preset <= 5) {
    params.preset = Math.round(obj.preset);
    applied++;
  }
  if (obj.layout === "reveal" || obj.layout === "none" || obj.layout === "row" || obj.layout === "side" || obj.layout === "full" || obj.layout === "page") {
    params.layout = obj.layout;
    applied++;
  }
  if (typeof obj.logoStyle === "string" && (LOGO_STYLES as string[]).includes(obj.logoStyle)) {
    params.logoStyle = obj.logoStyle as LogoStyle;
    applied++;
  }
  if (typeof obj.iconPos === "string" && (ICON_POSITIONS as string[]).includes(obj.iconPos)) {
    params.iconPos = obj.iconPos as IconPos;
    applied++;
  }
  if (obj.blockColor === "" || obj.blockColor === "topA" || obj.blockColor === "topB" || obj.blockColor === "bottomA" || obj.blockColor === "bottomB") {
    params.blockColor = obj.blockColor;
    applied++;
  }
  if (obj.logo === "off" || obj.logo === "top" || obj.logo === "bottom") {
    params.logo = obj.logo;
    applied++;
  }
  if (obj.logoColor === "black" || obj.logoColor === "white") {
    params.logoColor = obj.logoColor;
    applied++;
  }
  if (Array.isArray(obj.stack)) {
    const keys = (obj.stack as unknown[]).filter((k): k is StackKey => typeof k === "string" && (STACK_KEYS as string[]).includes(k));
    // keys the list does not know go where the defaults put them: the icon on top, the rest below
    const missing = STACK_KEYS.filter((k) => !keys.includes(k));
    params.stack = [...missing.filter((k) => k === "icon"), ...new Set(keys), ...missing.filter((k) => k !== "icon")];
    applied++;
  }
  if (obj.free && typeof obj.free === "object" && !Array.isArray(obj.free)) {
    const free: Params["free"] = {};
    for (const [k, v] of Object.entries(obj.free as Record<string, unknown>)) {
      if ((STACK_KEYS as string[]).includes(k) && typeof v === "number" && Number.isFinite(v)) free[k as StackKey] = clamp(v, 0, 1);
    }
    params.free = free;
    applied++;
  }
  if (typeof obj.groups === "string") {
    params.groups = obj.groups;
    applied++;
  }
  if (obj.loops === 1 || obj.loops === 2 || obj.loops === 4) {
    params.loops = obj.loops;
    applied++;
  }
  if (typeof obj.stackY === "number" && Number.isFinite(obj.stackY)) {
    params.stackY = clamp(obj.stackY, 0, 1);
    applied++;
  }
  for (const k of ["title", "day", "timeStart", "timeEnd", "artist", "stage", "artist2", ...INFO_KEYS] as const) {
    if (typeof obj[k] === "string") {
      params[k] = (obj[k] as string).slice(0, isInfoKey(k) ? 2000 : 200); // the info blocks hold paragraphs
      applied++;
    }
  }
  if (obj.colors && typeof obj.colors === "object") {
    const c = obj.colors as Record<string, unknown>;
    for (const k of Object.keys(params.colors) as (keyof Colors)[]) {
      const n = typeof c[k] === "string" ? normalizeHex(c[k] as string) : null;
      if (n) {
        params.colors[k] = n;
        applied++;
      }
    }
  }
  if (!applied) return false;
  syncUI();
  applyFormat();
  rebuild();
  return true;
}

// ---------- Figma ----------
// The card as native Figma layers: the background (photo, strips, floaters,
// logo) is one image, every text block an auto-layout frame with editable
// text, rows and the stack auto-layouted so edits re-flow and stay centred.
// Inside the plugin (figma-plugin/) the tool runs in an iframe and sends the
// description straight to it; anywhere else the button copies it, and the
// plugin can paste it.
const IN_PLUGIN = window.parent !== window && new URLSearchParams(location.search).has("plugin");
const figmaBtn = $<HTMLButtonElement>("figmaBtn");
figmaBtn.textContent = IN_PLUGIN ? "Send to Figma" : "Export Figma";
figmaBtn.title = IN_PLUGIN
  ? "Build the frame shown in the preview as editable Figma layers"
  : "Copy the frame shown in the preview for the Artist Card Figma plugin: run the plugin and press Paste from clipboard";
async function figmaSpec() {
  const snap = snapshot();
  const t = time % snap.scene.tl.total;
  await fontsReady(snap.p);
  const BG_SCALE = 2;
  const bg = document.createElement("canvas");
  bg.width = snap.scene.W * BG_SCALE;
  bg.height = snap.scene.H * BG_SCALE;
  const bctx = bg.getContext("2d")!;
  // the photo alone: strips, floaters, logo and text come as live layers
  render(bctx, snap.p, snap.scene, t, BG_SCALE, snap.image, { labels: false, strips: false, logo: false });
  const probe = document.createElement("canvas");
  probe.width = snap.scene.W;
  probe.height = snap.scene.H;
  const rows: SpecRow[] = [];
  const shapes: SpecShape[] = [];
  const lay = render(probe.getContext("2d")!, snap.p, snap.scene, t, 1, snap.image, { spec: rows, shapes });
  const lr = logoRect(snap.p, snap.scene, 1);
  const logoImages = getLogoImages(snap.p);
  const logo = lr && logoImages ? { svg: logoImages.svg, color: snap.p.logoColor, x: lr.x, y: lr.y, w: lr.w, h: lr.h } : null;
  const name = PRESET_NAMES[snap.p.preset] ?? "Artist card";
  return {
    v: 1,
    name: `${name} ${snap.p.format}`,
    w: snap.scene.W,
    h: snap.scene.H,
    gap: LABEL_GAP * snap.scene.S,
    font: { family: snap.p.fontFamily || "Avantt", style: "Bold" },
    colors: labelColors(snap.p),
    stack: lay.stackRect ? { anchor: snap.p.stackAnchor, top: lay.stackRect.y, bottom: lay.stackRect.y + lay.stackRect.h } : null,
    rows,
    shapes,
    logo,
    background: bg.toDataURL("image/jpeg", 0.92),
  };
}
// clipboard refused (a sandboxed frame, say): hand the text over to copy by hand
function offerText(text: string) {
  const dlg = document.createElement("dialog");
  dlg.className = "copy-dialog";
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  const p = document.createElement("p");
  p.textContent = "The clipboard is not available here. Press Cmd+C to copy, then use Paste from clipboard in the Artist Card plugin.";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  dlg.append(p, ta, close);
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  ta.focus();
  ta.select();
}
// ---------- InDesign ----------
const indesignBtn = $<HTMLButtonElement>("indesignBtn");
indesignBtn.addEventListener("click", async () => {
  indesignBtn.disabled = true;
  try {
    const spec = await figmaSpec();
    const { bytes, name } = buildIdmlZip(spec);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    flash(indesignBtn, "Exported");
  } catch (err) {
    console.error("[indesign]", err);
    alert("Could not build the InDesign file; check the console.");
  } finally {
    indesignBtn.disabled = false;
  }
});

// ---------- Illustrator ----------
const illustratorBtn = $<HTMLButtonElement>("illustratorBtn");
illustratorBtn.addEventListener("click", async () => {
  illustratorBtn.disabled = true;
  try {
    const spec = await figmaSpec();
    const { svg, name } = buildIllustratorSvg(spec);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    flash(illustratorBtn, "Exported");
  } catch (err) {
    console.error("[illustrator]", err);
    alert("Could not build the Illustrator file; check the console.");
  } finally {
    illustratorBtn.disabled = false;
  }
});

figmaBtn.addEventListener("click", async () => {
  figmaBtn.disabled = true;
  try {
    const spec = await figmaSpec();
    if (IN_PLUGIN) {
      window.parent.postMessage({ type: "artist-card-figma", spec }, "*");
      flash(figmaBtn, "Sent");
    } else {
      const text = JSON.stringify(spec);
      try {
        await navigator.clipboard.writeText(text);
        flash(figmaBtn, "Copied");
      } catch {
        offerText(text);
      }
    }
  } catch (err) {
    console.error("[figma]", err);
    alert("Could not prepare the Figma layers; check the console.");
  } finally {
    figmaBtn.disabled = false;
  }
});

function syncUI() {
  setFormatUI(params.format);
  setOrderUI(params.staggerOrder);
  setPresetUI(String(params.preset));
  setLoopsUI(String(params.loops));
  syncLayoutUI();
  syncVisibility();
  syncInfoSizes();
  syncBg();
  artist2El.value = params.artist2;
  for (const key of INFO_KEYS) {
    infoEls[key].value = params[key];
    autosize(infoEls[key]);
  }
  infoShown = 1;
  syncInfoRows();
  showArtist2(!!params.artist2 || artist2Shown);
  for (const def of stepDefs) syncStep(def.key);
  titleEl.value = params.title;
  autosize(titleEl);
  autosize(artistEl);
  autosize(artist2El);
  syncBlockRow();
  dayEl.value = params.day;
  timeStartEl.value = params.timeStart;
  timeEndEl.value = params.timeEnd;
  artistEl.value = params.artist;
  stageTextEl.value = params.stage;
  for (const k of Object.keys(params.colors) as (keyof Colors)[]) setColor(k, params.colors[k]);
}

// ---------- export ----------

function snapshot() {
  const p = structuredClone(params);
  return { p, scene: buildScene(p), image };
}
exportPngBtn.addEventListener("click", async () => {
  const snap = snapshot();
  exportPngBtn.disabled = true;
  try {
    await exportPng(snap.p, snap.scene, time % snap.scene.tl.total, EXPORT_SCALE, snap.image, video ? videoBeforeFrame : undefined);
  } catch (err) {
    console.error("[export]", err);
    alert("PNG export failed; check the console.");
  } finally {
    exportPngBtn.disabled = false;
  }
});
exportMp4Btn.addEventListener("click", async () => {
  if (!supportsVideoExport()) {
    if (IN_PLUGIN) await exportInBrowser();
    else alert("Video export needs WebCodecs (Chrome, Edge or Safari 16.4+).");
    return;
  }
  const wasPlaying = playing;
  setPlaying(false);
  const snap = snapshot();
  sidebar.inert = true;
  exportMp4Btn.disabled = true;
  exportPngBtn.disabled = true;
  try {
    const packets = audio ? await audioPackets(audio, audioStart, snap.scene.tl.total * Math.max(1, snap.p.loops)) : null;
    await exportMp4(
      snap.p,
      snap.scene,
      EXPORT_SCALE,
      FPS,
      snap.image,
      (f) => {
        exportMp4Btn.textContent = `Encoding ${Math.round(f * 100)}%`;
      },
      packets,
      video ? videoBeforeFrame : undefined,
    );
  } catch (err) {
    console.error("[export]", err);
    const msg = err instanceof Error ? err.message : String(err);
    alert(`MP4 export failed: ${msg}\nIf Safari keeps failing, Chrome encodes the same loop in a second.`);
  } finally {
    exportMp4Btn.textContent = "Export MP4";
    exportMp4Btn.disabled = false;
    exportPngBtn.disabled = false;
    sidebar.inert = false;
    if (wasPlaying && !playing) setPlaying(true);
    else schedule();
  }
});

// ---------- hooks for automated testing ----------

declare global {
  interface Window {
    artistCard: {
      params: Params;
      figmaSpec: () => Promise<unknown>;
      indesignZip: () => Promise<{ bytes: Uint8Array; name: string }>;
      illustratorSvg: () => Promise<{ svg: string; name: string }>;
      videoInfo: () => { duration: number; fps: number; width: number; height: number; codec: string; frameTime: number | null } | null;
      videoStart: () => number;
      undo: () => void;
      redo: () => void;
      historyDepth: () => { undo: number; redo: number };
      logoRect: () => Rect | null;
      setTime: (t: number) => void;
      apply: (json: string) => boolean;
      loadImageUrl: (url: string) => Promise<void>;
      render: () => void;
      total: () => number;
      layout: () => Layout;
    };
  }
}
// ---------- the shortcuts card ----------
// A small ? in the corner of the preview; hovering it (or pressing ?) shows
// every shortcut and gesture. One list, so the card and the handlers agree.

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const CMD = MAC ? "\u2318" : "Ctrl";
const ALT = MAC ? "\u2325" : "Alt";
const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Playback",
    [
      ["Space", "Play or pause"],
      ["\u2190 \u2192", "One frame back or forward"],
      ["\u21e7 \u2190 \u2192", "Ten frames"],
      ["Home / End", "First or last frame"],
    ],
  ],
  [
    "Edit",
    [
      [`${CMD} Z`, "Undo"],
      [`${CMD} \u21e7 Z`, "Redo"],
      ["\u2191 \u2193", "Previous or next colourway"],
      ["1 \u2013 4", "Layout preset"],
      ["F", "Next format (\u21e7 F back)"],
      ["L", "Logo off, top, bottom"],
      ["\u232b", "Clear the block row you are holding"],
      ["Esc", "Deselect the falloff handle"],
    ],
  ],
  [
    "Files",
    [
      [`${CMD} S`, "Save a .touquet file"],
      [`${CMD} O`, "Open a .touquet file"],
      [`${CMD} I`, "Load a photo or video"],
      [`${CMD} E`, "Export MP4"],
      [`${CMD} \u21e7 E`, "Export PNG"],
    ],
  ],
  [
    "Mouse",
    [
      ["Drag the photo", "Pan"],
      ["Scroll or pinch", "Zoom the photo (or the falloff)"],
      ["Drag the name", "Move the artist row"],
      ["Drag a block", "Move its row"],
      ["\u21e7 drag a block", "Move the whole stack"],
      ["Drag the handle", "Move the falloff (\u21e7 snaps to centre)"],
      ["Click a swatch", "Colour of the text blocks"],
      ["Double-click a swatch", "Pick a colour"],
      [`${ALT} click a swatch`, "Copy its hex"],
      ["Drag the strip", "Scrub the time, or move the music"],
      ["Drop a file", "Photo, video, MP3 or .touquet"],
    ],
  ],
];
const helpEl = $<HTMLDivElement>("help");
{
  const panel = $<HTMLDivElement>("helpPanel");
  for (const [title, rows] of SHORTCUTS) {
    const h = document.createElement("span");
    h.className = "title";
    h.textContent = title;
    panel.appendChild(h);
    for (const [key, what] of rows) {
      const k = document.createElement("kbd");
      k.textContent = key;
      const d = document.createElement("span");
      d.className = "what";
      d.textContent = what;
      panel.append(k, d);
    }
  }
  const helpBtn = $<HTMLButtonElement>("helpBtn");
  helpBtn.addEventListener("click", () => {
    if (!helpEl.classList.toggle("pinned")) helpBtn.blur();
  });
}

window.artistCard = {
  params,
  undo,
  redo,
  historyDepth: () => ({ undo: undoStack.length, redo: redoStack.length }),
  figmaSpec,
  indesignZip: async () => buildIdmlZip(await figmaSpec()),
  illustratorSvg: async () => buildIllustratorSvg(await figmaSpec()),
  videoInfo: () =>
    video
      ? { duration: video.duration, fps: video.fps, width: video.width, height: video.height, codec: video.codec, frameTime: video.reader.current?.timestamp ?? null }
      : null,
  videoStart: () => videoStart,
  logoRect: () => logoRect(params, scene, 1),
  setTime: (t: number) => {
    setTime(t);
    draw();
  },
  apply: applySettings,
  loadImageUrl: (url: string) =>
    new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        loadGen++;
        setImage({ source: img, width: img.naturalWidth, height: img.naturalHeight });
        draw();
        resolve();
      };
      img.onerror = () => reject(new Error("image failed"));
      img.src = url;
    }),
  render: draw,
  total: () => exportLength(),
  layout: () => layout,
};

// ---------- init ----------

/** The bundled default photo; a loaded, pasted or dropped image replaces it. */
function loadPhotoUrl(url: string) {
  if (!url) {
    loadGen++;
    clearVideo();
    imageFile = null;
    setImage(null);
    return;
  }
  const gen = ++loadGen;
  const img = new Image();
  img.onload = () => {
    if (gen !== loadGen) return;
    setImage({ source: img, width: img.naturalWidth, height: img.naturalHeight });
  };
  img.src = url;
}

applyFormat();
setImage(null);
void Promise.all([
  loadLogo("basic", `${import.meta.env.BASE_URL}logo-basic.svg`),
  loadLogo("10years", `${import.meta.env.BASE_URL}logo-10years.svg`),
  loadLogo("full", `${import.meta.env.BASE_URL}logo-full.svg`),
  loadLogo("icon", `${import.meta.env.BASE_URL}logo-icon.svg`),
]).then(() => rebuild());
syncUI();
if (!readHash()) rebuild();
// the photo that belongs to the preset in the link (the default one for the reveal)
loadPhotoUrl(presetPhoto(params.preset));
window.addEventListener("hashchange", () => {
  if (location.hash.replace(/^#/, "") !== lastHash) readHash();
});
document.fonts.load('700 100px "Avantt"').catch(() => undefined);
document.fonts.ready.then(() => schedule());
if (FIGMA_LAYER) setPlaying(true);
