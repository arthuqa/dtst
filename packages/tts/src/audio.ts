/** Audio formats: sniffing, file extensions, raw PCM → WAV, and durations, without dependencies. */

export type AudioFormat = "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
export const AUDIO_FORMATS: readonly AudioFormat[] = ["mp3", "wav", "opus", "aac", "flac", "pcm"];

const MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  pcm: "audio/pcm",
};

const EXTENSION: Record<AudioFormat, string> = {
  mp3: ".mp3",
  wav: ".wav",
  opus: ".opus",
  aac: ".aac",
  flac: ".flac",
  pcm: ".pcm",
};

const BY_EXTENSION: Record<string, AudioFormat> = {
  ".mp3": "mp3",
  ".wav": "wav",
  ".wave": "wav",
  ".opus": "opus",
  ".ogg": "opus",
  ".oga": "opus",
  ".aac": "aac",
  ".m4a": "aac",
  ".flac": "flac",
  ".pcm": "pcm",
  ".raw": "pcm",
};

export const mimeFor = (format: AudioFormat): string => MIME[format];
export const extensionFor = (format: AudioFormat): string => EXTENSION[format];

export function formatForExtension(extension: string | undefined): AudioFormat | undefined {
  return extension ? BY_EXTENSION[extension.toLowerCase().replace(/^\.?/, ".")] : undefined;
}

/** Detect an encoded audio format from its leading bytes; raw PCM has no signature and returns undefined. */
export function sniffAudio(data: Uint8Array): AudioFormat | undefined {
  const container = sniffContainer(data);
  if (container) return container;
  const [b0 = 0, b1 = 0] = data;
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return "aac"; // ADTS
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return "mp3"; // MPEG audio frame sync
  return undefined;
}

/** Formats with an unambiguous magic number (bare MP3/AAC frame sync is too weak to rule out raw PCM). */
function sniffContainer(data: Uint8Array): AudioFormat | undefined {
  const ascii = (start: number, end: number): string => String.fromCharCode(...data.subarray(start, end));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "opus";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (ascii(4, 8) === "ftyp") return "aac"; // MP4/M4A container
  return undefined;
}

export interface PcmLayout {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** OpenAI's `pcm` is 24 kHz, 16-bit, mono, little-endian; gateways may say otherwise in the Content-Type. */
export function pcmLayout(contentType: string): PcmLayout {
  const param = (name: string): number | undefined => {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*"?(\\d+)`, "i").exec(contentType);
    const value = match ? Number(match[1]) : NaN;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const l16 = /^audio\/l(8|16|24|32)\b/i.exec(contentType.trim());
  return {
    sampleRate: param("rate") ?? param("sample_rate") ?? 24_000,
    channels: param("channels") ?? 1,
    bitsPerSample: param("bits") ?? (l16 ? Number(l16[1]) : 16),
  };
}

/** True when the response is headerless PCM, by Content-Type or because PCM was what was asked for. */
export function isRawPcm(data: Uint8Array, contentType: string, requested: AudioFormat): boolean {
  if (/^audio\/(pcm|l\d+|raw|x-raw)\b/i.test(contentType.trim())) return !sniffContainer(data);
  return requested === "pcm" && !sniffAudio(data);
}

/** Prefix little-endian PCM samples with a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer, layout: PcmLayout): Buffer {
  const blockAlign = (layout.channels * layout.bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(layout.channels, 22);
  header.writeUInt32LE(layout.sampleRate, 24);
  header.writeUInt32LE(layout.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(layout.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Playback length in seconds for WAV (from its header) or raw PCM; undefined for compressed formats. */
export function audioDuration(data: Buffer, format: AudioFormat, layout?: PcmLayout): number | undefined {
  if (format === "pcm" && layout) {
    const bytesPerSecond = (layout.sampleRate * layout.channels * layout.bitsPerSample) / 8;
    return round(data.length / bytesPerSecond);
  }
  if (format !== "wav" || data.length < 44) return undefined;
  const byteRate = data.readUInt32LE(28);
  if (!byteRate) return undefined;
  // Walk the chunks to the `data` chunk; its declared size can be a streaming placeholder, so cap it.
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "data") return round(Math.min(size, data.length - offset - 8) / byteRate);
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

const round = (seconds: number): number => Math.round(seconds * 100) / 100;
