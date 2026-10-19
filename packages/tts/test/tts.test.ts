import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeProvider, callTool, connect, fakeProvider, tempDir, textOf } from "../../internal/test/helpers";
import { audioDuration, formatForExtension, pcmLayout, pcmToWav, sniffAudio } from "../src/audio";
import { createServer, synthesize } from "../src/server";

let provider: FakeProvider;
let root: string;

/** One second of 24 kHz 16-bit mono silence, as OpenAI-style raw PCM. */
const PCM_1S = Buffer.alloc(48_000);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64, 0xff)]);

async function client(env: Record<string, string> = {}) {
  vi.stubEnv("OPENAI_BASE_URL", provider.url);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
  vi.stubEnv("OPENAI_SPEECH_MODEL", "test/tts-model");
  vi.stubEnv("OPENAI_VOICE", "nova");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return connect(createServer(), { root });
}

beforeEach(async () => {
  provider = await fakeProvider();
  root = tempDir();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await provider.close();
});

describe("generate_speech", () => {
  it("sends text, voice and format, and saves an mp3 named after the text", async () => {
    provider.on("POST /audio/speech", { body: MP3, headers: { "content-type": "audio/mpeg" } });
    const result = await callTool(await client(), "generate_speech", {
      text: "Welcome to the quarterly update",
      instructions: "Warm and calm.",
      speed: 1.1,
    });

    expect(result.isError).toBeFalsy();
    expect(provider.requests[0]?.json).toEqual({
      model: "test/tts-model",
      input: "Welcome to the quarterly update",
      voice: "nova",
      response_format: "mp3",
      speed: 1.1,
      instructions: "Warm and calm.",
    });
    const saved = result.structuredContent as Record<string, unknown>;
    expect(saved).toMatchObject({
      model: "test/tts-model",
      voice: "nova",
      mime_type: "audio/mpeg",
      bytes: MP3.length,
      characters: 31,
    });
    expect(saved["path"]).toBe(path.join(root, "welcome-quarterly-update.mp3"));
    expect(readFileSync(saved["path"] as string)).toEqual(MP3);
    expect(result.content.some((block) => block.type === "resource_link")).toBe(true);
    expect(result.content.some((block) => block.type === "audio")).toBe(false);
  });

  it("wraps raw PCM into WAV, honouring the rate in the Content-Type", async () => {
    provider.on("POST /audio/speech", {
      body: PCM_1S,
      headers: { "content-type": "audio/pcm;rate=24000;channels=1" },
    });
    const result = await callTool(await client(), "generate_speech", {
      text: "Hello",
      output: "audio/hello.wav",
      inline: true,
    });

    const saved = result.structuredContent as Record<string, unknown>;
    expect(provider.requests[0]?.json.response_format).toBe("wav");
    expect(saved).toMatchObject({ path: path.join(root, "audio", "hello.wav"), mime_type: "audio/wav", duration_s: 1 });
    const wav = readFileSync(saved["path"] as string);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(PCM_1S.length + 44);
    expect(result.content[0]).toMatchObject({ type: "audio", mimeType: "audio/wav" });
  });

  it("does not mistake PCM that starts like an MP3 frame sync for MP3", async () => {
    const pcm = Buffer.concat([Buffer.from([0xff, 0xfb, 0xfe, 0xff]), Buffer.alloc(23_996)]);
    provider.on("POST /audio/speech", { body: pcm, headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
    const result = await callTool(await client(), "generate_speech", { text: "Hi", output: "hi.wav" });
    expect(result.structuredContent).toMatchObject({ path: path.join(root, "hi.wav"), duration_s: 0.5 });
  });

  it("asks OpenRouter for PCM when WAV is wanted and rejects formats it cannot return", async () => {
    provider.on("POST /audio/speech", { body: PCM_1S, headers: { "content-type": "audio/pcm" } });
    const config = {
      baseUrl: provider.url,
      apiKey: "sk-test-123456",
      imageApi: "auto" as const,
      timeoutMs: 5000,
      headers: {},
      openRouter: true,
    };
    const signal = new AbortController().signal;
    const base = { model: "m", input: "hi", voice: "v", args: {}, signal };
    const speech = await synthesize(config, { ...base, format: "wav" });
    expect(provider.requests[0]?.json.response_format).toBe("pcm");
    expect(speech).toMatchObject({ format: "wav", durationS: 1 });
    await expect(synthesize(config, { ...base, format: "flac" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("reads the text from a file and never overwrites by default", async () => {
    provider.on("POST /audio/speech", { body: MP3, headers: { "content-type": "audio/mpeg" } });
    writeFileSync(path.join(root, "script.md"), "Line one.\nLine two.");
    writeFileSync(path.join(root, "out.mp3"), "existing");
    const result = await callTool(await client(), "generate_speech", { file: "script.md", output: "out.mp3" });

    expect(provider.requests[0]?.json.input).toBe("Line one.\nLine two.");
    expect((result.structuredContent as Record<string, unknown>)["path"]).toBe(path.join(root, "out-1.mp3"));
    expect(readFileSync(path.join(root, "out.mp3"), "utf8")).toBe("existing");
  });

  it("corrects the extension when the provider returns another format", async () => {
    provider.on("POST /audio/speech", { body: MP3, headers: { "content-type": "audio/mpeg" } });
    const result = await callTool(await client(), "generate_speech", { text: "Hi there", output: "clip.flac" });
    const saved = result.structuredContent as Record<string, unknown>;
    expect(saved["path"]).toBe(path.join(root, "clip.mp3"));
    expect(existsSync(path.join(root, "clip.flac"))).toBe(false);
    expect(textOf(result)).toMatch(/returned mp3 instead of flac/);
  });

  it("defaults the voice to the model's first listed voice", async () => {
    provider.on("GET /models", {
      json: {
        data: [
          { id: "test/tts-model", architecture: { output_modalities: ["speech"] }, supported_voices: ["Kore", "Puck"] },
        ],
      },
    });
    provider.on("POST /audio/speech", { body: MP3, headers: { "content-type": "audio/mpeg" } });
    const result = await callTool(await client({ OPENAI_VOICE: "" }), "generate_speech", { text: "Hi" });
    expect(result.isError).toBeFalsy();
    expect(provider.requests.find((request) => request.path === "/audio/speech")?.json.voice).toBe("Kore");
  });

  it("explains a rejected voice, a JSON body and missing input", async () => {
    provider.on("POST /audio/speech", { status: 400, json: { error: { message: 'Unknown voice "zed".', code: 400 } } });
    const connected = await client();
    let result = await callTool(connected, "generate_speech", { text: "Hi", voice: "zed" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^BAD_INPUT: Unknown voice[\s\S]*Hint: .*list_speech_models/);

    provider.on("POST /audio/speech", { json: { audio: "not bytes" } });
    result = await callTool(connected, "generate_speech", { text: "Hi" });
    expect(textOf(result)).toMatch(/^PROVIDER: Expected binary data/);

    result = await callTool(connected, "generate_speech", {});
    expect(textOf(result)).toMatch(/^BAD_INPUT: Nothing to say/);
    result = await callTool(connected, "generate_speech", { text: "a", file: "b.txt" });
    expect(textOf(result)).toMatch(/^BAD_INPUT: Pass either/);
  });

  it("gives format, option and voice hints for provider 400s (Fish Audio wording)", async () => {
    const connected = await client();
    const reject = (message: string): void =>
      provider.on("POST /audio/speech", { status: 400, json: { error: { code: 400, message } } });

    reject('unsupported response_format "flac" (supported: mp3, pcm, pcm16, wav, opus)');
    let result = await callTool(connected, "generate_speech", { text: "Hi", format: "flac" });
    expect(textOf(result)).toMatch(
      /^BAD_INPUT: unsupported response_format[\s\S]*Hint: This endpoint does not offer flac; pick another `format`/,
    );

    reject("'instructions' is not supported by this gateway: Fish Audio has no instruction-following TTS");
    result = await callTool(connected, "generate_speech", { text: "Hi", instructions: "calm" });
    expect(textOf(result)).toMatch(
      /^BAD_INPUT: [\s\S]*Hint: This endpoint does not support `instructions`; retry without it\./,
    );

    reject("Reference not found");
    result = await callTool(connected, "generate_speech", { text: "Hi", voice: "ffff" });
    expect(textOf(result)).toMatch(
      /^BAD_INPUT: Reference not found\nHint: Voice "ffff" is not available for test\/tts-model/,
    );

    reject("Provider returned 400");
    result = await callTool(connected, "generate_speech", { text: "Hi" });
    expect(textOf(result)).toMatch(/^PROVIDER: Provider returned 400\nHint: Check that the model does text-to-speech/);
  });

  it("requires a model", async () => {
    const result = await callTool(await client({ OPENAI_SPEECH_MODEL: "", OPENAI_MODEL: "" }), "generate_speech", {
      text: "Hi",
    });
    expect(textOf(result)).toMatch(/^CONFIG: No speech model configured/);
  });
});

describe("list_speech_models", () => {
  it("lists speech models with voices and filters by voice name", async () => {
    provider.on("GET /models", {
      json: {
        data: [
          { id: "acme/chat", architecture: { output_modalities: ["text"] } },
          {
            id: "acme/tts-1",
            name: "Acme TTS",
            architecture: { output_modalities: ["speech"] },
            supported_voices: ["Kore"],
          },
          { id: "acme/tts-2", architecture: { output_modalities: ["speech"] }, supported_voices: ["Puck"] },
          { id: "tts-1-hd" },
        ],
      },
    });
    const connected = await client();
    let result = await callTool(connected, "list_speech_models", {});
    expect(textOf(result)).toContain("Default model: test/tts-model · voice: nova");
    expect(textOf(result)).toContain("3 of 3 models:");
    expect(textOf(result)).toContain("- acme/tts-1 (Acme TTS)\n  voices: Kore");
    expect(textOf(result)).not.toContain("acme/chat");

    result = await callTool(connected, "list_speech_models", { query: "puck" });
    expect(textOf(result)).toContain("1 of 3 models:\n- acme/tts-2");
  });
});

describe("audio helpers", () => {
  it("sniffs formats and maps extensions", () => {
    expect(sniffAudio(MP3)).toBe("mp3");
    expect(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(sniffAudio(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
    expect(sniffAudio(Buffer.from("OggS\0\0"))).toBe("opus");
    expect(sniffAudio(Buffer.from("fLaC\0\0"))).toBe("flac");
    expect(sniffAudio(pcmToWav(PCM_1S, pcmLayout("audio/pcm")))).toBe("wav");
    expect(sniffAudio(PCM_1S)).toBeUndefined();
    expect(formatForExtension(".OGG")).toBe("opus");
    expect(formatForExtension(".m4a")).toBe("aac");
    expect(formatForExtension(".png")).toBeUndefined();
  });

  it("reads PCM layout from Content-Type and computes durations", () => {
    expect(pcmLayout("audio/pcm;rate=16000;channels=2")).toEqual({ sampleRate: 16000, channels: 2, bitsPerSample: 16 });
    expect(pcmLayout("audio/L16; rate=44100")).toEqual({ sampleRate: 44100, channels: 1, bitsPerSample: 16 });
    const layout = pcmLayout("");
    expect(audioDuration(PCM_1S, "pcm", layout)).toBe(1);
    expect(audioDuration(pcmToWav(PCM_1S.subarray(0, 12_000), layout), "wav")).toBe(0.25);
    expect(audioDuration(MP3, "mp3")).toBeUndefined();
  });
});
