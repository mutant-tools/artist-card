// Music for the video: an MP3 the user loads. Decoded once for the waveform
// and the preview playback; for the export its encoded frames go into the
// MP4 as they are (no re-encoding), cut at the chosen start.
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink, type EncodedPacket, type AudioCodec } from "mediabunny";

export interface AudioTrack {
  name: string;
  bytes: ArrayBuffer;
  duration: number; // s
  peaks: Float32Array; // 0..1, PEAK_BINS over the whole track
  buffer: AudioBuffer;
}

export const PEAK_BINS = 600;

let actx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!actx) actx = new AudioContext();
  return actx;
}

export async function loadAudioFile(file: File): Promise<AudioTrack> {
  const bytes = await file.arrayBuffer();
  const buffer = await audioContext().decodeAudioData(bytes.slice(0));
  const ch = buffer.getChannelData(0);
  const peaks = new Float32Array(PEAK_BINS);
  const per = Math.max(1, Math.floor(ch.length / PEAK_BINS));
  let max = 0;
  for (let i = 0; i < PEAK_BINS; i++) {
    let m = 0;
    const start = i * per;
    const end = Math.min(ch.length, start + per);
    for (let j = start; j < end; j += 4) {
      const v = Math.abs(ch[j]);
      if (v > m) m = v;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  if (max > 0) for (let i = 0; i < PEAK_BINS; i++) peaks[i] /= max;
  return { name: file.name, bytes, duration: buffer.duration, peaks, buffer };
}

// ---- preview playback ----

let source: AudioBufferSourceNode | null = null;
export function playAudio(track: AudioTrack, offset: number) {
  stopAudio();
  const ctx = audioContext();
  if (ctx.state === "suspended") void ctx.resume();
  const s = ctx.createBufferSource();
  s.buffer = track.buffer;
  s.connect(ctx.destination);
  const at = Math.max(0, Math.min(track.duration - 0.01, offset));
  s.start(0, at);
  source = s;
}
export function stopAudio() {
  if (source) {
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
    source = null;
  }
}

// ---- export: the encoded packets inside [start, start + length) ----

export interface AudioPackets {
  codec: AudioCodec;
  sampleRate: number;
  numberOfChannels: number;
  decoderConfig: AudioDecoderConfig | null;
  packets: EncodedPacket[]; // timestamps rebased so the first one starts at 0
}

export async function audioPackets(track: AudioTrack, start: number, length: number): Promise<AudioPackets | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(track.bytes) });
  const t = await input.getPrimaryAudioTrack();
  if (!t || !t.codec) return null;
  const sink = new EncodedPacketSink(t);
  const decoderConfig = await t.getDecoderConfig();
  const packets: EncodedPacket[] = [];
  const first = await sink.getPacket(start);
  if (!first) return null;
  // start at the packet that contains `start`, so the sound is right from frame one
  const base = first.timestamp;
  for await (const pk of sink.packets(first)) {
    if (pk.timestamp - base >= length) break;
    packets.push(pk.clone({ timestamp: pk.timestamp - base }));
  }
  return { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.numberOfChannels, decoderConfig, packets };
}
