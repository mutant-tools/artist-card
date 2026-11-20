// A video behind the card. Whatever comes in (MP4, MOV, WebM; H.264, HEVC,
// ProRes, VP9, AV1; any frame rate or size) is converted once, on import,
// into one uniform clip: H.264 in an MP4 held in memory, no audio, a key
// frame every half second, at most 2160 px on the long side, at most 60
// fps. Playback and exports then decode that clip themselves with
// WebCodecs, frame by frame, driven by the tool's own clock. No <video>
// element is involved after the import, so there is nothing for the
// browser to throttle, drift or skip.
//
// Two decoders: WebCodecs through Mediabunny when the browser can decode
// the source (the fast path); otherwise a <video> element is stepped
// through the file one frame at a time and those frames are encoded.
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  canEncodeVideo,
  type VideoCodec,
  type WrappedCanvas,
} from "mediabunny";

const MAX_LONG_SIDE = 2160;
const MAX_FPS = 60;
const KEYFRAME_INTERVAL = 0.5; // s; seeks decode at most half a second of frames
const FALLBACK_FPS = 30; // when the frames come from a <video> element, whose rate is unknown

export interface VideoClip {
  file: File; // the original, kept for .touquet files
  duration: number; // s
  width: number; // the frames' size
  height: number;
  fps: number;
  codec: string; // the source codec, for the UI
  converted: boolean; // false when the source is played as it is (a conversion failed)
  reader: FrameReader;
}

export type Progress = (fraction: number, stage: "decoding" | "converting") => void;

/**
 * Frames in presentation order. Sequential reads (playback, export) walk one
 * decoder pass; a jump backwards or far ahead starts a new pass at the
 * wanted time, which costs at most half a second of decoding.
 */
export class FrameReader {
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private cur: WrappedCanvas | null = null;
  private pending: Promise<WrappedCanvas | null> | null = null;
  constructor(
    private sink: CanvasSink,
    readonly duration: number,
  ) {}
  /** The frame shown at `t` (seconds into the clip), or the last one before it. */
  frameAt(t: number): Promise<WrappedCanvas | null> {
    if (this.pending) return this.pending.then(() => this.frameAt(t));
    const p = this.read(t).finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }
  /** True while a frame is being decoded; playback skips a tick rather than queueing. */
  get busy(): boolean {
    return this.pending !== null;
  }
  get current(): WrappedCanvas | null {
    return this.cur;
  }
  private async read(t: number): Promise<WrappedCanvas | null> {
    const want = Math.max(0, Math.min(t, Math.max(0, this.duration - 0.001)));
    const c = this.cur;
    if (c && want >= c.timestamp && want < c.timestamp + c.duration) return c;
    // ahead, but not too far: walk forward
    if (this.iter && c && want >= c.timestamp && want - c.timestamp < 1.5) {
      for (;;) {
        const n = await this.iter.next();
        if (n.done) break;
        const f = n.value;
        if (want < f.timestamp) {
          // the wanted time falls in a gap before this frame; keep the previous one and remember this one
          this.cur = f;
          return this.cur;
        }
        this.cur = f;
        if (want < f.timestamp + f.duration) return f;
      }
    }
    // a seek: a fresh pass from the wanted time
    void this.iter?.return();
    this.iter = this.sink.canvases(want);
    const n = await this.iter.next();
    if (n.done) {
      this.iter = null;
      return this.cur;
    }
    this.cur = n.value;
    return this.cur;
  }
  close() {
    void this.iter?.return();
    this.iter = null;
    this.cur = null;
  }
}

function fit(w: number, h: number): { width: number; height: number } {
  const long = Math.max(w, h);
  const k = long > MAX_LONG_SIDE ? MAX_LONG_SIDE / long : 1;
  // even sizes for the encoder
  return { width: Math.max(2, Math.round((w * k) / 2) * 2), height: Math.max(2, Math.round((h * k) / 2) * 2) };
}

async function outputCodec(width: number, height: number): Promise<VideoCodec> {
  for (const c of ["avc", "hevc", "vp9", "av1"] as VideoCodec[]) {
    if (await canEncodeVideo(c, { width, height })) return c;
  }
  throw new Error("This browser cannot encode video");
}

/** Convert a decodable source with Mediabunny: decode, scale, re-encode. */
async function convertWithWebCodecs(input: Input, width: number, height: number, fps: number, onProgress: Progress): Promise<ArrayBuffer> {
  const codec = await outputCodec(width, height);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: { codec, width, height, fit: "fill", frameRate: fps, quality: QUALITY_HIGH, keyFrameInterval: KEYFRAME_INTERVAL, forceTranscode: true, alpha: "discard" },
    audio: { discard: true },
    showWarnings: false,
  });
  if (!conversion.isValid) throw new Error("conversion not possible: " + conversion.discardedTracks.map((d) => d.reason).join(", "));
  conversion.onProgress = (f) => onProgress(f, "converting");
  await conversion.execute();
  if (!target.buffer) throw new Error("conversion produced nothing");
  return target.buffer;
}

function waitEvent(el: HTMLVideoElement, ok: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      el.removeEventListener(ok, onOk);
      el.removeEventListener("error", onErr);
      err ? reject(err) : resolve();
    };
    const onOk = () => finish();
    const onErr = () => finish(new Error("video failed"));
    el.addEventListener(ok, onOk);
    el.addEventListener("error", onErr);
    setTimeout(() => finish(new Error("video timed out")), ms);
  });
}

/**
 * Convert a source WebCodecs cannot decode by stepping a <video> element
 * through it and encoding what it shows, at a fixed rate.
 */
async function convertWithVideoElement(file: File, onProgress: Progress): Promise<{ buffer: ArrayBuffer; fps: number; width: number; height: number; duration: number }> {
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  const url = URL.createObjectURL(file);
  el.src = url;
  try {
    await waitEvent(el, "loadedmetadata", 15000);
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !el.videoWidth) throw new Error("no video in that file");
    const { width, height } = fit(el.videoWidth, el.videoHeight);
    const fps = FALLBACK_FPS;
    const codec = await outputCodec(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: KEYFRAME_INTERVAL });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    const n = Math.max(1, Math.round(duration * fps));
    for (let i = 0; i < n; i++) {
      const t = Math.min(i / fps, duration - 0.001);
      if (Math.abs(el.currentTime - t) > 1 / (fps * 4)) {
        el.currentTime = t;
        await waitEvent(el, "seeked", 4000).catch(() => undefined);
      }
      ctx.drawImage(el, 0, 0, width, height);
      await source.add(i / fps, 1 / fps);
      onProgress(i / n, "decoding");
    }
    source.close();
    await output.finalize();
    if (!target.buffer) throw new Error("conversion produced nothing");
    return { buffer: target.buffer, fps, width, height, duration: n / fps };
  } finally {
    el.removeAttribute("src");
    el.load();
    URL.revokeObjectURL(url);
  }
}

async function openClip(buffer: ArrayBuffer): Promise<{ input: Input; sink: CanvasSink; duration: number; width: number; height: number; fps: number }> {
  const input = new Input({ formats: [MP4], source: new BufferSource(buffer) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("the converted clip has no video");
  const [duration, stats] = await Promise.all([track.computeDuration(), track.computePacketStats(200)]);
  const width = track.displayWidth;
  const height = track.displayHeight;
  const sink = new CanvasSink(track, { width, height, fit: "fill", poolSize: 4 });
  return { input, sink, duration, width, height, fps: stats.averagePacketRate };
}

/** Import a video file: convert it to the uniform clip and open it for reading. */
export async function importVideo(file: File, onProgress: Progress): Promise<VideoClip> {
  let buffer: ArrayBuffer | null = null;
  let codec = "";
  let converted = true;
  // the fast path: the browser decodes the source itself
  let sourceInput: Input | null = null;
  try {
    sourceInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track = await sourceInput.getPrimaryVideoTrack();
    if (track && (await track.canDecode())) {
      codec = track.codec ?? "";
      const stats = await track.computePacketStats(200);
      const fps = Math.min(MAX_FPS, Math.max(1, Math.round(stats.averagePacketRate * 1000) / 1000));
      const { width, height } = fit(track.displayWidth, track.displayHeight);
      buffer = await convertWithWebCodecs(sourceInput, width, height, fps, onProgress);
    }
  } catch (e) {
    console.warn("[video] WebCodecs conversion failed, trying the video element", e);
    buffer = null;
  }
  if (!buffer) {
    const r = await convertWithVideoElement(file, onProgress);
    buffer = r.buffer;
    codec = codec || "browser";
  }
  const clip = await openClip(buffer);
  return {
    file,
    duration: clip.duration,
    width: clip.width,
    height: clip.height,
    fps: clip.fps,
    codec,
    converted,
    reader: new FrameReader(clip.sink, clip.duration),
  };
}
