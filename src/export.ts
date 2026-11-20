import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } from "mediabunny";
import { render, type ImageSource, type Params, type Scene, FORMATS } from "./engine";
import type { AudioPackets } from "./audio";

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function fileStem(p: Params, scale: number): string {
  const parts = [slug(p.artist), slug(p.day)].filter(Boolean);
  const name = parts.length ? parts.join("-") : "artist-card";
  const [w, h] = FORMATS[p.format];
  return `${name}-${w * scale}x${h * scale}`;
}
/** Before a frame is drawn: a video background seeks to the frame's time. */
export type BeforeFrame = (t: number) => Promise<void>;

export async function fontsReady(p: Params) {
  try {
    await document.fonts.load(`700 100px "${p.fontFamily}"`);
    await document.fonts.ready;
  } catch {
    /* render with whatever is available */
  }
}

export async function exportPng(
  p: Params,
  scene: Scene,
  t: number,
  scale: number,
  image: ImageSource | null,
  beforeFrame?: BeforeFrame,
) {
  await fontsReady(p);
  const c = document.createElement("canvas");
  c.width = scene.W * scale;
  c.height = scene.H * scale;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  if (beforeFrame) await beforeFrame(t);
  render(ctx, p, scene, t, scale, image); // transparent where there is no photo
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (blob) downloadBlob(blob, `${fileStem(p, scale)}-${t.toFixed(2)}s.png`);
}

/** Lowest H.264 High-profile level whose frame-size and throughput limits fit. */
function pickH264Codec(w: number, h: number, fps: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = mbs * fps;
  const levels: [string, number, number][] = [
    ["1F", 8192, 108000], // 3.1
    ["28", 8192, 245760], // 4.0
    ["2A", 8704, 522240], // 4.2
    ["32", 22080, 589824], // 5.0
    ["33", 36864, 983040], // 5.1
    ["34", 36864, 2073600], // 5.2
    ["3C", 139264, 4177920], // 6.0
    ["3D", 139264, 8355840], // 6.1
    ["3E", 139264, 16711680], // 6.2
  ];
  const level = levels.find(([, maxMbs, maxMbps]) => mbs <= maxMbs && mbps <= maxMbps)?.[0] ?? "3E";
  return `avc1.6400${level}`;
}

export function supportsVideoExport(): boolean {
  return "VideoEncoder" in window && "VideoFrame" in window;
}

class StallError extends Error {}

const isWebKit = () => {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR/.test(ua);
};

/**
 * Encoder configs to try, in order. Safari 27's H.264 Main/High encoder in
 * the default "quality" latency mode takes a few frames and never emits
 * output (WebKit bug 324827, fixed in 27.2); "realtime" mode and the
 * Baseline profile work, so Safari starts there and every browser falls
 * through the list when an attempt stalls.
 */
function encoderConfigs(outW: number, outH: number, fps: number): VideoEncoderConfig[] {
  const codec = pickH264Codec(outW, outH, fps);
  // generous: flat colour fields band at low rates
  const bitrate = Math.min(240_000_000, Math.round(outW * outH * fps * 0.4));
  const base = { width: outW, height: outH, framerate: fps, bitrate };
  const quality: VideoEncoderConfig = { ...base, codec, bitrateMode: "variable", avc: { format: "avc" } };
  const realtime: VideoEncoderConfig = { ...base, codec, latencyMode: "realtime", avc: { format: "avc" } };
  const baseline: VideoEncoderConfig = { ...base, codec: "avc1.42001f", latencyMode: "realtime", avc: { format: "avc" } };
  const plain: VideoEncoderConfig = { ...base, codec };
  return isWebKit() ? [realtime, baseline, quality, plain] : [quality, realtime, baseline, plain];
}

async function configSupported(c: VideoEncoderConfig): Promise<boolean> {
  try {
    return !!(await VideoEncoder.isConfigSupported(c)).supported;
  } catch {
    return false;
  }
}

/** One encoding attempt with a given config; throws StallError if the encoder stops producing. */
async function encodeLoop(
  config: VideoEncoderConfig,
  p: Params,
  scene: Scene,
  scale: number,
  fps: number,
  image: ImageSource | null,
  canvas: HTMLCanvasElement,
  onProgress: (fraction: number) => void,
  audio: AudioPackets | null,
  beforeFrame?: BeforeFrame,
): Promise<ArrayBuffer> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context");
  const outW = canvas.width;
  const outH = canvas.height;
  const loops = Math.max(1, Math.round(p.loops || 1));
  const totalFrames = Math.max(1, Math.round(scene.tl.total * loops * fps));
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const videoSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(videoSource);
  const audioSource = audio && audio.packets.length ? new EncodedAudioPacketSource(audio.codec) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();
  let encoderError: unknown = null;
  let chunks = 0;
  let lastChunkAt = performance.now();
  let writes: Promise<void>[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        writes.push(videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta).catch((e) => void (encoderError = e)));
        chunks++;
        lastChunkAt = performance.now();
      } catch (e) {
        encoderError = e;
      }
    },
    error: (e) => {
      encoderError = e;
    },
  });
  const STALL_MS = 8_000;
  const flushWithWatchdog = async () => {
    const started = performance.now();
    let done = false;
    const flushed = encoder.flush().then(
      () => (done = true),
      (e) => (encoderError = e),
    );
    while (!done) {
      await Promise.race([flushed, sleep(200)]);
      if (done) break;
      if (encoderError) throw encoderError;
      if (performance.now() - Math.max(lastChunkAt, started) > STALL_MS) {
        throw new StallError(`Encoder stalled after ${chunks} frames (${config.codec}, ${config.latencyMode ?? "quality"})`);
      }
    }
  };
  try {
    encoder.configure(config);
    for (let i = 0; i < totalFrames; i++) {
      if (encoderError) throw encoderError;
      const t = (i / fps) % scene.tl.total;
      if (beforeFrame) await beforeFrame(i / fps);
      render(ctx, p, scene, t, scale, image, { background: "#ffffff" }); // H.264 has no alpha
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // bounded queue: let the encoder catch up every few frames
      if (i % 4 === 3) await flushWithWatchdog();
      onProgress(i / totalFrames);
      await sleep(0);
    }
    await flushWithWatchdog();
    await Promise.all(writes);
    writes = [];
    if (encoderError) throw encoderError;
    if (chunks === 0) throw new StallError("The encoder produced no frames");
    if (audioSource && audio) {
      const meta = audio.decoderConfig ? { decoderConfig: audio.decoderConfig } : undefined;
      for (let i = 0; i < audio.packets.length; i++) await audioSource.add(audio.packets[i], i === 0 ? meta : undefined);
    }
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("The muxer produced no file");
    return buffer;
  } finally {
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch {
      /* already closed */
    }
  }
}

/** Encode exactly one loop (scene.tl.total seconds) to H.264 MP4. */
export async function exportMp4(
  p: Params,
  scene: Scene,
  scale: number,
  fps: number,
  image: ImageSource | null,
  onProgress: (fraction: number) => void,
  audio: AudioPackets | null = null,
  beforeFrame?: BeforeFrame,
) {
  await fontsReady(p);
  const outW = Math.max(16, Math.floor((scene.W * scale) / 2) * 2);
  const outH = Math.max(16, Math.floor((scene.H * scale) / 2) * 2);
  const c = document.createElement("canvas");
  c.width = outW;
  c.height = outH;
  let lastError: unknown = null;
  for (const config of encoderConfigs(outW, outH, fps)) {
    if (!(await configSupported(config))) continue;
    try {
      const buffer = await encodeLoop(config, p, scene, scale, fps, image, c, onProgress, audio, beforeFrame);
      downloadBlob(new Blob([buffer], { type: "video/mp4" }), `${fileStem(p, scale)}.mp4`);
      return;
    } catch (e) {
      lastError = e;
      if (!(e instanceof StallError)) throw e;
      console.warn("[export] retrying with the next encoder config:", (e as Error).message);
      onProgress(0);
    }
  }
  throw lastError ?? new Error("No supported H.264 encoder configuration");
}
