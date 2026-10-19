/**
 * Fish Audio's native API: `POST /v1/tts` with the model in a `model` header and voices as
 * `reference_id` (one id, or one per `<|speaker:N|>` turn). Needed for models the
 * OpenAI-compatible gateway does not serve, such as `drama-3`.
 */

import { type Config, DtstError, api, badInput, log } from "@dtst/internal";
import type { AudioFormat, PcmLayout } from "./audio";

/** Native `pcm` carries no rate in its Content-Type, so it is always requested at this rate. */
const PCM_RATE = 44_100;
const DEFAULT_MODEL = "s2.1-pro";

/** Fish documents its catalog but serves no model list on the native API. */
export const FISH_MODELS: readonly { id: string; name: string }[] = [
  { id: "drama-3", name: "Drama 3: directable; [directions], <whisper>…</whisper>, multi-speaker" },
  { id: "s2.1-pro", name: "S2.1 Pro: production multilingual TTS (Fish default)" },
  { id: "s2.1-pro-free", name: "S2.1 Pro free tier, for prototyping" },
  { id: "s2-pro", name: "S2 Pro: expressive narration and multi-speaker" },
  { id: "s1", name: "S1 (deprecated)" },
];

export function usesFishApi(config: Config): boolean {
  if (config.speechApi !== "auto") return config.speechApi === "fish";
  const host = new URL(config.baseUrl).hostname;
  return host === "fish.audio" || host.endsWith(".fish.audio");
}

/** API root for the native endpoints: the origin for fish.audio, else the base URL without a trailing `/v1`. */
function nativeConfig(config: Config): Config {
  const url = new URL(config.baseUrl);
  const isFishHost = url.hostname === "fish.audio" || url.hostname.endsWith(".fish.audio");
  return { ...config, baseUrl: isFishHost ? url.origin : config.baseUrl.replace(/\/v1$/, "") };
}

export const fishDefaultModel = DEFAULT_MODEL;

/** `fish-audio/drama-3` (OpenRouter-style id) and `drama-3` both name the same model. */
export function fishModel(model: string): string {
  return model.replace(/^fish-audio\//, "");
}

/** `id` → one reference; `id1, id2, id3` → one per speaker, in `<|speaker:N|>` order. */
export function fishReference(voice: string | undefined): string | string[] | undefined {
  const ids = (voice ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  return ids.length === 1 ? ids[0] : ids;
}

export interface FishCall {
  config: Config;
  endpoint: string;
  json: Record<string, unknown>;
  headers: Record<string, string>;
  wire: AudioFormat;
  layout?: PcmLayout;
}

export function fishRequest(
  config: Config,
  request: {
    model: string;
    input: string;
    voice?: string | undefined;
    format: AudioFormat;
    args: { instructions?: string | undefined; speed?: number | undefined };
  },
): FishCall {
  if (request.format === "aac" || request.format === "flac") {
    throw new DtstError(
      "UNSUPPORTED",
      `Fish Audio returns mp3, wav, opus or pcm, not ${request.format}.`,
      "Pick another `format`.",
    );
  }
  // WAV is built locally from PCM: Fish's streamed WAV header carries placeholder sizes.
  const wire: AudioFormat = request.format === "wav" ? "pcm" : request.format;
  const json: Record<string, unknown> = { text: withDirection(request.input, request.args.instructions), format: wire };
  const reference = fishReference(request.voice);
  if (reference) json["reference_id"] = reference;
  if (wire === "pcm") json["sample_rate"] = PCM_RATE;
  if (request.args.speed !== undefined) json["prosody"] = { speed: request.args.speed };
  return {
    config: nativeConfig(config),
    endpoint: "/v1/tts",
    json,
    headers: { model: fishModel(request.model) },
    wire,
    ...(wire === "pcm" ? { layout: { sampleRate: PCM_RATE, channels: 1, bitsPerSample: 16 } } : {}),
  };
}

/** Fish has no `instructions` field; a leading `[direction]` is how its models take delivery notes. */
function withDirection(input: string, instructions: string | undefined): string {
  const direction = instructions?.trim();
  if (!direction) return input;
  if (/^\s*<\|speaker:\d+\|>/.test(input)) {
    throw badInput(
      "`instructions` cannot apply to a multi-speaker script.",
      "Put a [direction] at the start of each <|speaker:N|> turn instead.",
    );
  }
  return `[${direction.replace(/^\[|\]$/g, "")}] ${input}`;
}

export interface FishVoice {
  id: string;
  title: string;
  languages: string[];
}

interface VoicesResponse {
  items?: { _id?: string; title?: string; languages?: string[]; type?: string; state?: string }[];
}

/** Your own voices, plus public library voices whose title matches `query`. */
export async function listFishVoices(
  config: Config,
  query: string | undefined,
  signal: AbortSignal,
): Promise<{ own: FishVoice[]; library: FishVoice[] }> {
  const native = nativeConfig(config);
  const fetchVoices = async (params: string): Promise<FishVoice[]> => {
    try {
      const { items = [] } = await api<VoicesResponse>(native, `/model?${params}`, { signal });
      return items
        .filter((item) => item._id && (item.type ?? "tts") === "tts" && (item.state ?? "trained") === "trained")
        .map((item) => ({ id: item._id!, title: item.title ?? "", languages: item.languages ?? [] }));
    } catch (error) {
      log.debug("fish voice list failed", String(error));
      return [];
    }
  };
  const [own, library] = await Promise.all([
    fetchVoices("self=true&page_size=50"),
    query?.trim()
      ? fetchVoices(`title=${encodeURIComponent(query.trim())}&page_size=10&sort_by=score`)
      : Promise.resolve([]),
  ]);
  return { own, library };
}
