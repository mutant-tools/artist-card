import "./style.css";
import "vanilla-colorful/hex-color-picker.js";
import type { HexColorPicker } from "vanilla-colorful/hex-color-picker.js";
import {
  type Rect,
  COLORWAYS,
  LABEL_GAP,
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
  type LogoColor,
  type LogoPos,
  type Params,
  type Scene,
  type SpecRow,
  type StackKey,
  type StaggerOrder,
} from "./engine";
import { exportMp4, exportPng, fontsReady, supportsVideoExport } from "./export";
import { loadLogo } from "./logo";
import { audioPackets, loadAudioFile, playAudio, stopAudio, windowPeaks, type AudioTrack } from "./audio";

const FPS = 60; // frame counter, arrow-key stepping and MP4 export
const TICKS_PER_SECOND = 15; // timeline tick pitch
const EXPORT_SCALE = 2; // 2160 wide

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
  const q = new URLSearchParams(h);
  const obj: Record<string, unknown> = {};
  const def = flatten(DEFAULT_PARAMS);
  for (const [k, v] of q.entries()) {
    const freeKey = k.startsWith("free.");
    if (!(k in def) && !freeKey) continue;
    const value: unknown =
      k === "easing" ? v.split(",").map(Number) : k === "stack" ? v.split(",").filter(Boolean) : freeKey || typeof def[k] === "number" ? parseFloat(v) : v;
    const path = k.split(".");
    let host = obj;
    for (const part of path.slice(0, -1)) {
      host[part] = (host[part] as Record<string, unknown>) ?? {};
      host = host[part] as Record<string, unknown>;
    }
    host[path[path.length - 1]] = value;
  }
  lastHash = h;
  return applySettings(JSON.stringify(obj));
}
function rebuild() {
  scene = buildScene(params);
  if (time > exportLength()) time = 0;
  buildTicks();
  syncTime();
  if (audio) setAudioStart(audioStart);
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
function scrubAt(clientX: number) {
  const r = ticksEl.getBoundingClientRect();
  if (r.width <= 0) return;
  setTime(clamp((clientX - r.left) / r.width, 0, 1) * exportLength());
}
let scrubbing = false;
ticksEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  scrubbing = true;
  ticksEl.setPointerCapture(e.pointerId);
  scrubAt(e.clientX);
});
ticksEl.addEventListener("pointermove", (e) => {
  if (scrubbing) scrubAt(e.clientX);
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
    requestAnimationFrame(tick);
  } else {
    stopAudio();
    schedule();
  }
}
function setTime(t: number) {
  if (playing) setPlaying(false);
  time = clamp(t, 0, exportLength());
  syncTime();
  schedule();
}
frameBtn.addEventListener("click", () => setPlaying(!playing));

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName ?? "";
  if (t?.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || tag === "INPUT") return;
  if (e.metaKey || e.ctrlKey) return;
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
const PRESET_NAMES: Record<number, string> = { 1: "Reveal", 2: "Infos Pratiques", 3: "Full blocks", 4: "App TMB26" };
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
    infoSize: "s",
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
    infoSize: "m",
    stackAnchor: "top",
    stackY: EDGE,
    colors: { ...DEFAULT_PARAMS.colors, topA: "#8D5DF3", topB: "#0906B7", bottomA: "#FF63F4", bottomB: "#ED00A5" },
  },
};
function presetPhoto(n: number): string {
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
const logoRow = $<HTMLDivElement>("logoRow");
const logoColorSeg = $<HTMLDivElement>("logoColorSeg");
function syncLayoutUI() {
  const reveal = params.layout === "reveal";
  logoRow.hidden = reveal;
  logoColorSeg.hidden = params.logo === "off";
  setLogoUI(params.logo);
  setLogoColorUI(params.logoColor);
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
  | "floatTravel";

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
}
const stepDefs: StepDef[] = [
  { key: "holdClosed", label: "Hold closed", min: 0, max: 20, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup" },
  { key: "duration", label: "Opening time", min: 0.1, max: 6, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup", title: "One row's open / close transition; the block moves follow the same easing" },
  { key: "opening", label: "Opening %", min: 0, max: 100, step: 5, decimals: 0, container: "timingGroup", title: "How far the rows open; the edge blocks stay on top of that" },
  { key: "vignette", label: "Vignette %", min: 0, max: 100, step: 5, decimals: 0, container: "timingGroup", title: "How much the hole follows the falloff circle on the preview: 0 = two vertical lines, 100 = the circle" },
  { key: "faith", label: "Faith %", min: 0, max: 100, step: 5, decimals: 0, container: "timingGroup", title: "100 = the hole follows the falloff, 0 = complete chaos (a random width per row and side)" },
  { key: "holdOpen", label: "Hold open", min: 0, max: 30, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup" },
  { key: "labelTime", label: "Text time", min: 0.3, max: 3, step: 0.1, decimals: 1, suffix: "s", container: "timingGroup", title: "How long one label block takes to come in or go" },
  { key: "loopLen", label: "Loop length", min: 0.5, max: 30, step: 0.5, decimals: 1, suffix: "s", container: "timingGroup", title: "One-stage posters: how long the stripes' motion cycle is" },
  { key: "rowsTop", label: "Rows top", min: 0, max: 24, step: 1, decimals: 0, container: "rowsGroup" },
  { key: "rowsBottom", label: "Rows bottom", min: 0, max: 24, step: 1, decimals: 0, container: "rowsGroup" },
  { key: "stripPx", label: "Strip height", min: 12, max: 120, step: 6, decimals: 0, container: "rowsGroup", title: "Block row: height of one strip row in px at 1080" },
  { key: "stagger", label: "Rows stagger", min: 0, max: 1, step: 0.05, decimals: 2, container: "shapeGroup", title: "Seconds between rows; the closing runs in reverse order" },
  { key: "irregularity", label: "Irregularity %", min: 0, max: 100, step: 5, decimals: 0, container: "shapeGroup", title: "Extra blocks left standing per row and side, more towards the outer rows" },
  { key: "shapeSeed", label: "Shape seed", min: 0, max: 999999, step: 1, decimals: 0, container: "shapeGroup" },
  { key: "unitPx", label: "Block size", min: 12, max: 90, step: 3, decimals: 0, container: "blocksGroup", title: "The stripe unit in px at 1080: 45 in the reveal, 24 for the side blocks" },
  { key: "blockWidth", label: "Block width", min: 1, max: 8, step: 1, decimals: 0, container: "blocksGroup", title: "Widest edge block in an open row, in units (one unit = card width / 24); the blocks breathe two units below that" },
  { key: "blockTravel", label: "Block travel", min: 0, max: 12, step: 1, decimals: 0, container: "blocksGroup", title: "Largest sideways step of a row's pattern, in units" },
  { key: "blockSeed", label: "Block seed", min: 0, max: 999999, step: 1, decimals: 0, container: "blocksGroup" },
  { key: "floatCount", label: "Floaters", min: 0, max: 60, step: 1, decimals: 0, container: "floatGroup", title: "Floating blocks spread over the open rows; they grow, shrink to nothing and back, and drift" },
  { key: "floatSize", label: "Floaters size", min: 0.5, max: 8, step: 0.5, decimals: 1, container: "floatGroup", title: "Largest floating block in units (smallest is half)" },
  { key: "floatTravel", label: "Floaters travel", min: 0, max: 600, step: 10, decimals: 0, container: "floatGroup", title: "Largest sideways step of a floating block, px on the 1080 canvas" },
];
const numParams = params as unknown as Record<NumKey, number>;
const stepInputs: Partial<Record<NumKey, HTMLInputElement>> = {};
const stepRows: Record<string, HTMLElement> = {};

function fmtStep(def: StepDef, v: number) {
  return `${v.toFixed(def.decimals)}${def.suffix ?? ""}`;
}
function syncStep(key: NumKey) {
  const def = stepDefs.find((d) => d.key === key);
  const inp = stepInputs[key];
  if (def && inp) inp.value = fmtStep(def, numParams[key]);
}
function renderStep(def: StepDef) {
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
  none: [...ONE_STAGE_OFF, "opening", "vignette", "faith", "rowsTop", "rowsBottom", "stripPx", "irregularity", "shapeSeed", "unitPx", "blockWidth", "blockTravel", "blockSeed", "floatCount", "floatSize", "floatTravel"],
  row: [...ONE_STAGE_OFF, "opening", "vignette", "faith", "irregularity", "shapeSeed", "blockWidth", "floatCount", "floatSize", "floatTravel"],
  side: [...ONE_STAGE_OFF, "stripPx"],
  full: [...ONE_STAGE_OFF, "stripPx"],
};
// Text fields per preset: the artist cards (1, 3) take day, time, artist and
// stage; the info posters (2, 4) a title and the sentence.
const TEXT_ROWS: Record<string, number[]> = {
  titleRow: [2, 4],
  infoRow: [2, 4],
  dayRow: [1, 3],
  timeRow: [1, 3],
  artistRow: [1, 3],
  stageRow: [1, 3],
};
const MOVABLE_GROUPS = ["blocksGroup", "timingGroup", "shapeGroup", "rowsGroup", "floatGroup", "colorGroup"];
function syncVisibility() {
  const layout = params.layout;
  const hidden = new Set<NumKey>(HIDDEN_STEPS[layout]);
  for (const def of stepDefs) stepRows[def.key].hidden = hidden.has(def.key);
  const oneStage = layout !== "reveal";
  $<HTMLDivElement>("orderSeg").hidden = oneStage; // the stagger order only shapes the reveal
  $<HTMLDivElement>("colorGroup").hidden = layout === "none"; // no stripes, no stripe colours
  for (const [id, presets] of Object.entries(TEXT_ROWS)) $<HTMLElement>(id).hidden = !presets.includes(params.preset);
  if (!TEXT_ROWS.artistRow.includes(params.preset)) artist2Row.hidden = true;
  else artist2Row.hidden = !artist2Shown;
  // a group with nothing left in it goes too
  for (const id of ["timingGroup", "rowsGroup", "shapeGroup", "blocksGroup", "floatGroup"]) {
    const g = $<HTMLElement>(id);
    g.hidden = Array.from(g.children).every((c) => (c as HTMLElement).hidden);
  }
  balanceColumns();
}
// The two settings columns keep about the same height: the text fields
// stay top left and Loops / Export bottom right, the groups in between go
// to whichever column is shorter. The reveal keeps the design's own order.
function balanceColumns() {
  const left = $<HTMLDivElement>("colLeft");
  const right = $<HTMLDivElement>("colRight");
  const exportGroup = $<HTMLElement>("exportGroup");
  const GAP = 24;
  const groups = MOVABLE_GROUPS.map((id) => $<HTMLElement>(id));
  if (params.layout === "reveal") {
    for (const g of groups.slice(0, 2)) left.appendChild(g);
    for (const g of groups.slice(2)) right.insertBefore(g, exportGroup);
    return;
  }
  for (const g of groups) g.remove();
  const heightOf = (el: HTMLElement) => (el.hidden ? 0 : el.offsetHeight + GAP);
  let lh = Array.from(left.children).reduce((a, c) => a + heightOf(c as HTMLElement), 0);
  let rh = Array.from(right.children).reduce((a, c) => a + heightOf(c as HTMLElement), 0);
  for (const g of groups) {
    if (g.hidden) {
      left.appendChild(g);
      continue;
    }
    if (lh <= rh) {
      left.appendChild(g);
      lh += heightOf(g);
    } else {
      right.insertBefore(g, exportGroup);
      rh += heightOf(g);
    }
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
  const btn = el.parentElement?.querySelector<HTMLElement>(".btn.tall");
  if (btn) btn.style.height = "";
  el.style.height = "auto";
  const lines = Math.max(1, Math.round((el.scrollHeight - 12) / 11));
  const h = lines <= 1 ? 32 : 24 + 11 * lines;
  el.style.height = `${h}px`;
  if (btn) btn.style.height = `${h}px`;
}
const titleEl = bindText("titleText", (v) => (params.title = v));
const dayEl = bindText("dayText", (v) => (params.day = v));
const timeStartEl = bindText("timeStartText", (v) => (params.timeStart = v));
const timeEndEl = bindText("timeEndText", (v) => (params.timeEnd = v));
const artistEl = bindText("artistText", (v) => (params.artist = v));
const stageTextEl = bindText("stageText", (v) => (params.stage = v));
const artist2El = bindText("artist2Text", (v) => (params.artist2 = v));
const infoEl = bindText("infoText", (v) => (params.info = v));
const infoSizeBtn = $<HTMLButtonElement>("infoSizeBtn");
infoSizeBtn.addEventListener("click", () => {
  params.infoSize = params.infoSize === "s" ? "m" : "s";
  infoSizeBtn.textContent = params.infoSize.toUpperCase();
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
for (const el of [titleEl, dayEl, timeStartEl, timeEndEl, artistEl, stageTextEl, artist2El, infoEl]) el.addEventListener("input", () => rebuild());
for (const el of [titleEl, infoEl]) el.addEventListener("input", () => autosize(el));
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
function buildColorRow() {
  const host = $<HTMLDivElement>("colorGroup");
  host.innerHTML = "";
  const row = document.createElement("div");
  row.className = "row colours";
  row.innerHTML = `
    <span class="lbl">Colours</span>
    <button type="button" class="btn w20" data-dir="-1" title="Previous colourway">\u2190</button>
    <input type="text" class="w45 center" id="colorwayIndex" spellcheck="false" title="Colourway 1 to ${COLORWAYS.length}" />
    <div class="swatch-grid">
      ${swatchKeys.map((k) => `<button type="button" class="swatch" data-key="${k}"></button>`).join("")}
    </div>
    <button type="button" class="btn w20" data-dir="1" title="Next colourway">\u2192</button>`;
  for (const sw of row.querySelectorAll<HTMLButtonElement>(".swatch")) {
    const key = sw.dataset.key as keyof Colors;
    swatches[key] = sw;
    sw.style.background = params.colors[key];
    sw.title = params.colors[key];
    sw.addEventListener("click", () => openPicker(sw, key));
    sw.addEventListener("pointerenter", () => (hoveredSwatch = key));
    sw.addEventListener("pointerleave", () => {
      if (hoveredSwatch === key) hoveredSwatch = null;
    });
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
    const file = Array.from(data.files ?? []).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      loadImageFile(file);
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
function loadImageFile(file: File) {
  if (!file.type.startsWith("image/")) return;
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
  setImage(null);
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f) loadImageFile(f);
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
  if (f) loadImageFile(f);
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
type DragMode = "none" | "label" | "pan" | "falloff" | "block" | "stack";
let drag: DragMode = "none";
let dragMoved = false;
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
  for (const key of [...STACK_KEYS].reverse()) {
    const r = layout.blocks[key];
    if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return key;
  }
  return null;
}
function stackedKeys(): StackKey[] {
  return params.stack.filter((k) => layout.blocks[k] && params.free[k] === undefined);
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
function dragBlock(py: number, k: number) {
  const key = dragKey!;
  const H = canvas.height;
  const cyB = py - grabDY;
  const me = layout.blocks[key]!;
  const y0 = cyB - me.h / 2;
  const y1 = cyB + me.h / 2;
  const sr = othersRect(key);
  if (!sr) {
    // nothing else in the stack: this block is the stack, so dragging it
    // moves the stack itself (keeps it a stack for others to snap into)
    delete params.free[key];
    params.stackY = clamp((params.stackAnchor === "top" ? y0 : y1) / H, 0, 1);
    // a free block it is brought up against joins it, staying where it is
    for (const o of STACK_KEYS) {
      const ro = layout.blocks[o];
      if (o === key || params.free[o] === undefined || !ro) continue;
      if (gapTo(y0, y1, ro) < (DETACH / 2) * k) {
        delete params.free[o];
        const above = cyB < ro.y + ro.h / 2;
        params.stackAnchor = above ? "bottom" : "top";
        params.stackY = clamp((above ? ro.y + ro.h : ro.y) / H, 0, 1);
        reorderTo(key, cyB);
        break;
      }
    }
  } else if (params.free[key] !== undefined) {
    params.free[key] = clamp(cyB / H, 0, 1);
    // back against the stack: snap in at the row under the pointer
    if (gapTo(y0, y1, sr) < (DETACH / 2) * k) {
      delete params.free[key];
      reorderTo(key, cyB);
    }
  } else {
    // pulled clear of the other blocks: detach and sit at its own height
    if (gapTo(y0, y1, sr) > DETACH * k) params.free[key] = clamp(cyB / H, 0, 1);
    else reorderTo(key, cyB);
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
  else if (key === "info") infoEl.value = params.info = "";
  delete params.free[key];
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
  dragKey = falloffSelected ? null : blockAt(pt.x, pt.y);
  if (dragKey) {
    const r = layout.blocks[dragKey]!;
    grabDY = pt.y - (r.y + r.h / 2);
    drag = e.shiftKey ? "stack" : "block";
    canvas.classList.add("block-drag");
  } else if (e.shiftKey && !falloffSelected && overStack(pt.x, pt.y)) {
    drag = "stack";
    canvas.classList.add("block-drag");
  } else drag = falloffSelected ? "falloff" : overArtist(pt.x, pt.y) ? "label" : image ? "pan" : "none";
  if (wasSelected !== falloffSelected) schedule();
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
    const overB = !overF && !!blockAt(pt.x, pt.y);
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
  if (drag === "block") {
    dragBlock(pt.y, pt.k);
    return;
  } else if (drag === "stack") {
    params.stackY = clamp(params.stackY + dy / canvas.height, 0, 1);
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
    canvas.classList.remove("panning", "block-drag");
    drag = "none";
    dragKey = null;
  });
}
canvas.addEventListener("pointerleave", () => {
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
  if (!image) fileInput.click();
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
  if (obj.infoSize === "s" || obj.infoSize === "m") {
    params.infoSize = obj.infoSize;
    applied++;
  }
  if (typeof obj.preset === "number" && obj.preset >= 1 && obj.preset <= 4) {
    params.preset = Math.round(obj.preset);
    applied++;
  }
  if (obj.layout === "reveal" || obj.layout === "none" || obj.layout === "row" || obj.layout === "side" || obj.layout === "full") {
    params.layout = obj.layout;
    applied++;
  }
  if (obj.logo === "off" || obj.logo === "top" || obj.logo === "bottom") {
    params.logo = params.layout === "reveal" ? "off" : obj.logo;
    applied++;
  }
  if (obj.logoColor === "black" || obj.logoColor === "white") {
    params.logoColor = obj.logoColor;
    applied++;
  }
  if (Array.isArray(obj.stack)) {
    const keys = (obj.stack as unknown[]).filter((k): k is StackKey => typeof k === "string" && (STACK_KEYS as string[]).includes(k));
    params.stack = [...new Set(keys), ...STACK_KEYS.filter((k) => !keys.includes(k))];
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
  if (obj.loops === 1 || obj.loops === 2 || obj.loops === 4) {
    params.loops = obj.loops;
    applied++;
  }
  if (typeof obj.stackY === "number" && Number.isFinite(obj.stackY)) {
    params.stackY = clamp(obj.stackY, 0, 1);
    applied++;
  }
  for (const k of ["title", "day", "timeStart", "timeEnd", "artist", "stage", "artist2", "info"] as const) {
    if (typeof obj[k] === "string") {
      params[k] = (obj[k] as string).slice(0, 200);
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
const copyBtn = $<HTMLButtonElement>("copySettingsBtn");
const pasteBtn = $<HTMLButtonElement>("pasteSettingsBtn");
copyBtn.addEventListener("click", async () => {
  const str = JSON.stringify(params);
  try {
    await navigator.clipboard.writeText(str);
    flash(copyBtn, "Copied");
  } catch {
    prompt("Copy settings:", str);
  }
});
pasteBtn.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = prompt("Paste settings string:") ?? "";
  }
  if (!text) return;
  flash(pasteBtn, applySettings(text) ? "Applied" : "Invalid", 1200);
});

// ---------- Figma ----------
// The card as native Figma layers: the background (photo, strips, floaters,
// logo) is one image, every text block an auto-layout frame with editable
// text, rows and the stack auto-layouted so edits re-flow and stay centred.
// Inside the plugin (figma-plugin/) the tool runs in an iframe and sends the
// description straight to it; anywhere else the button copies it, and the
// plugin can paste it.
const IN_PLUGIN = window.parent !== window && new URLSearchParams(location.search).has("plugin");
const figmaBtn = $<HTMLButtonElement>("figmaBtn");
figmaBtn.textContent = IN_PLUGIN ? "Send to Figma" : "Copy for Figma";
figmaBtn.title = IN_PLUGIN
  ? "Build the frame shown in the preview as editable Figma layers"
  : "Copy the frame shown in the preview for the Artist Card Figma plugin (paste it there)";
async function figmaSpec() {
  const snap = snapshot();
  const t = time % snap.scene.tl.total;
  await fontsReady(snap.p);
  const BG_SCALE = 2;
  const bg = document.createElement("canvas");
  bg.width = snap.scene.W * BG_SCALE;
  bg.height = snap.scene.H * BG_SCALE;
  const bctx = bg.getContext("2d")!;
  render(bctx, snap.p, snap.scene, t, BG_SCALE, snap.image, { labels: false });
  const probe = document.createElement("canvas");
  probe.width = snap.scene.W;
  probe.height = snap.scene.H;
  const rows: SpecRow[] = [];
  const lay = render(probe.getContext("2d")!, snap.p, snap.scene, t, 1, snap.image, { spec: rows });
  const name = PRESET_NAMES[snap.p.preset] ?? "Artist card";
  return {
    v: 1,
    name: `${name} ${snap.p.format}`,
    w: snap.scene.W,
    h: snap.scene.H,
    gap: LABEL_GAP * snap.scene.S,
    font: { family: snap.p.fontFamily || "Avantt", style: "Bold" },
    colors: { bg: snap.p.colors.labelBg, text: snap.p.colors.labelText },
    stack: lay.stackRect ? { anchor: snap.p.stackAnchor, top: lay.stackRect.y, bottom: lay.stackRect.y + lay.stackRect.h } : null,
    rows,
    background: bg.toDataURL("image/png"),
  };
}
figmaBtn.addEventListener("click", async () => {
  figmaBtn.disabled = true;
  try {
    const spec = await figmaSpec();
    if (IN_PLUGIN) {
      window.parent.postMessage({ type: "artist-card-figma", spec }, "*");
      flash(figmaBtn, "Sent");
    } else {
      await navigator.clipboard.writeText(JSON.stringify(spec));
      flash(figmaBtn, "Copied");
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
  infoSizeBtn.textContent = params.infoSize.toUpperCase();
  artist2El.value = params.artist2;
  infoEl.value = params.info;
  autosize(infoEl);
  showArtist2(!!params.artist2 || artist2Shown);
  for (const def of stepDefs) syncStep(def.key);
  titleEl.value = params.title;
  autosize(titleEl);
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
    await exportPng(snap.p, snap.scene, time % snap.scene.tl.total, EXPORT_SCALE, snap.image);
  } catch (err) {
    console.error("[export]", err);
    alert("PNG export failed; check the console.");
  } finally {
    exportPngBtn.disabled = false;
  }
});
exportMp4Btn.addEventListener("click", async () => {
  if (!supportsVideoExport()) {
    alert("Video export needs WebCodecs (Chrome, Edge or Safari 16.4+).");
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
      setTime: (t: number) => void;
      apply: (json: string) => boolean;
      loadImageUrl: (url: string) => Promise<void>;
      render: () => void;
      total: () => number;
      layout: () => Layout;
    };
  }
}
window.artistCard = {
  params,
  figmaSpec,
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
void loadLogo(`${import.meta.env.BASE_URL}logo.svg`).then(() => schedule());
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
