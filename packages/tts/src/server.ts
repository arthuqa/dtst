import {
  type Config,
  DtstError,
  Server,
  VERSION,
  api,
  apiBinary,
  badInput,
  fileLink,
  loadInputs,
  log,
  planOutput,
  slug,
  text,
  writeOutput,
} from "@dtst/internal";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AUDIO_FORMATS,
  type AudioFormat,
  type PcmLayout,
  audioDuration,
  extensionFor,
  formatForExtension,
  isRawPcm,
  mimeFor,
  pcmLayout,
  pcmToWav,
  sniffAudio,
} from "./audio";

export const NAME = "dtst-tts";

const INSTRUCTIONS = `Text-to-speech; every result is saved to an audio file.
- generate_speech: \`text\` (or a text \`file\`) → spoken audio, read verbatim.
- Pass \`output\` when the user names a file or folder; otherwise files land in the workspace root.
- \`instructions\` steers tone, pace, emotion or accent on models that support it.
- Unsure about a model id or its voices? Call list_speech_models.`;

/** OpenAI's default voice, used when nothing is configured and the endpoint does not list voices. */
const FALLBACK_VOICE = "alloy";
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export function createServer(env: NodeJS.ProcessEnv = process.env): Server {
  const defaultModel = env["OPENAI_SPEECH_MODEL"]?.trim() || env["OPENAI_MODEL"]?.trim() || undefined;
  const defaultVoice = env["OPENAI_VOICE"]?.trim() || undefined;
  const server = new Server(
    { name: NAME, version: VERSION },
    `${INSTRUCTIONS}\n- Configured model: ${defaultModel ?? "none (pass `model`)"}; voice: ${defaultVoice ?? "provider default"}.`,
  );

  server.tool(
    "generate_speech",
    {
      title: "Generate speech",
      description: "Turn text into spoken audio with the configured voice and save it to disk.",
      input: {
        text: z.string().min(1).max(100_000).optional().describe("What to say, read verbatim."),
        file: z
          .string()
          .optional()
          .describe("A text file (path or URL) to read aloud instead of `text`, e.g. a script or notes."),
        voice: z
          .string()
          .min(1)
          .optional()
          .describe(
            defaultVoice
              ? `Omit to use the configured voice (${defaultVoice}). Set only if the user asks for a different voice.`
              : "Voice name; voices differ per model (see list_speech_models).",
          ),
        model: z
          .string()
          .min(1)
          .optional()
          .describe(
            defaultModel
              ? `Omit to use the configured model (${defaultModel}). Set only if the user asks for a different model.`
              : "Speech model id (no default is configured; see list_speech_models).",
          ),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe('Delivery direction, e.g. "calm and warm, slow pace" (models that support it).'),
        speed: z.number().min(0.25).max(4).optional().describe("Playback speed, 0.25–4 (default 1), where supported."),
        format: z
          .enum(AUDIO_FORMATS as [AudioFormat, ...AudioFormat[]])
          .optional()
          .describe("Audio encoding. Default: from `output`'s extension, else mp3. `pcm` is raw 16-bit samples."),
        output: z
          .string()
          .optional()
          .describe(
            'File ("audio/intro.mp3") or folder ("audio/") to save to, relative to the workspace. Default: workspace root, named after the text.',
          ),
        overwrite: z.boolean().optional().describe("Replace an existing file (default false: pick a free name)."),
        inline: z
          .boolean()
          .optional()
          .describe("Also return the audio in the reply, for clients that can play it (default false; up to 2 MB)."),
      },
      output: {
        model: z.string(),
        voice: z.string(),
        path: z.string(),
        mime_type: z.string(),
        bytes: z.number(),
        duration_s: z.number().optional(),
        characters: z.number(),
        notes: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, { config, root, signal, progress }) => {
      if (args.text?.trim() && args.file) throw badInput("Pass either `text` or `file`, not both.");
      const input = args.file ? await readText(args.file, root, signal) : (args.text ?? "");
      if (!input.trim()) throw badInput("Nothing to say: pass non-empty `text` or a text `file`.");

      const model = args.model ?? config.speechModel ?? config.textModel;
      if (!model) {
        throw new DtstError("CONFIG", "No speech model configured.", "Set OPENAI_SPEECH_MODEL or pass `model`.");
      }
      const voice = args.voice ?? config.voice ?? (await firstVoice(config, model, signal)) ?? FALLBACK_VOICE;

      const plan = await planOutput(args.output, root, slug(input, "speech"));
      const format = args.format ?? formatForExtension(plan.extension) ?? "mp3";
      const notes: string[] = [];
      if (plan.extension && !formatForExtension(plan.extension) && !args.format) {
        notes.push(`"${plan.extension}" is not an audio extension; saved as ${format}.`);
      }

      await progress(`speaking ${input.length} characters with ${voice}`);
      const audio = await synthesize(config, { model, input, voice, format, args, signal });
      if (audio.format !== format) {
        notes.push(`The provider returned ${audio.format} instead of ${format}, so the file extension was adjusted.`);
      }

      // Keep the caller's spelling of a matching extension (.ogg for opus, .m4a for aac).
      const extension =
        plan.extension && formatForExtension(plan.extension) === audio.format
          ? plan.extension
          : extensionFor(audio.format);
      const file = await writeOutput(plan, extension, audio.data, { overwrite: args.overwrite });
      const mimeType = mimeFor(audio.format);
      const bytes = audio.data.byteLength;

      const content: ContentBlock[] = [];
      if (args.inline && bytes <= MAX_INLINE_BYTES) {
        content.push({ type: "audio", data: audio.data.toString("base64"), mimeType });
      } else if (args.inline) {
        notes.push("The audio is too large to return inline; open the file.");
      }
      content.push(fileLink(file, mimeType, bytes));
      const length = audio.durationS === undefined ? "" : ` · ${audio.durationS.toFixed(1)} s`;
      content.push(
        text(
          [
            `Saved speech (${model}, voice ${voice}):`,
            `- ${file} · ${audio.format}${length} · ${formatBytes(bytes)}`,
            ...notes.map((note) => `Note: ${note}`),
          ].join("\n"),
        ),
      );

      return {
        content,
        structuredContent: {
          model,
          voice,
          path: file,
          mime_type: mimeType,
          bytes,
          ...(audio.durationS === undefined ? {} : { duration_s: audio.durationS }),
          characters: input.length,
          ...(notes.length > 0 ? { notes } : {}),
        },
      };
    },
  );

  server.tool(
    "list_speech_models",
    {
      title: "List speech models",
      description: "List the text-to-speech models this endpoint offers, with their voices when known.",
      input: {
        query: z.string().optional().describe("Case-insensitive filter on id, name and voice names."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum results (default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, { config, signal }) => {
      const all = await listSpeechModels(config, signal);
      const query = args.query?.toLowerCase();
      const models = all
        .filter(
          (model) =>
            !query || [model.id, model.name ?? "", ...(model.voices ?? [])].join(" ").toLowerCase().includes(query),
        )
        .slice(0, args.limit ?? 50);
      const lines = models.map(
        (model) =>
          `- ${model.id}${model.name ? ` (${model.name})` : ""}${model.voices?.length ? `\n  voices: ${model.voices.join(", ")}` : ""}`,
      );
      const current = config.speechModel ?? config.textModel ?? "none — set OPENAI_SPEECH_MODEL";
      return {
        content: [
          text(
            [
              `Default model: ${current} · voice: ${config.voice ?? "provider default"}`,
              `${models.length} of ${all.length} models:`,
              ...lines,
            ].join("\n"),
          ),
        ],
      };
    },
  );

  return server;
}

// ── synthesis ──────────────────────────────────────────────────────────────

interface SpeechRequest {
  model: string;
  input: string;
  voice: string;
  format: AudioFormat;
  args: { instructions?: string | undefined; speed?: number | undefined };
  signal: AbortSignal;
}

interface Speech {
  data: Buffer;
  format: AudioFormat;
  durationS?: number;
}

/** POST /audio/speech. WAV is built locally from PCM where the endpoint only streams raw samples. */
export async function synthesize(config: Config, request: SpeechRequest): Promise<Speech> {
  // OpenRouter accepts only mp3 | pcm; everyone else gets the format that was asked for.
  if (config.openRouter && !["mp3", "pcm", "wav"].includes(request.format)) {
    throw new DtstError(
      "UNSUPPORTED",
      `OpenRouter speech returns mp3 or raw PCM, not ${request.format}.`,
      "Use format mp3 or wav (wav is built from PCM locally).",
    );
  }
  const wire = config.openRouter && request.format === "wav" ? "pcm" : request.format;
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    voice: request.voice,
    response_format: wire,
  };
  if (request.args.speed !== undefined) body["speed"] = request.args.speed;
  if (request.args.instructions?.trim()) body["instructions"] = request.args.instructions;

  let response;
  try {
    response = await apiBinary(config, "/audio/speech", { json: body, signal: request.signal });
  } catch (error) {
    throw explain(error, request, wire);
  }
  log.debug(`speech: ${response.data.length} bytes of ${response.contentType || "unknown type"}`);

  if (isRawPcm(response.data, response.contentType, wire)) {
    const layout = pcmLayout(response.contentType);
    if (request.format === "pcm") return withDuration(response.data, "pcm", layout);
    return withDuration(pcmToWav(response.data, layout), "wav");
  }
  const sniffed = sniffAudio(response.data) ?? formatFromMime(response.contentType);
  if (!sniffed) {
    throw new DtstError(
      "PROVIDER",
      `The provider returned ${response.contentType || "data"} that is not recognisable audio.`,
      "Check that the model is a text-to-speech model (list_speech_models).",
    );
  }
  return withDuration(response.data, sniffed);
}

function withDuration(data: Buffer, format: AudioFormat, layout?: PcmLayout): Speech {
  const durationS = audioDuration(data, format, layout);
  return { data, format, ...(durationS === undefined ? {} : { durationS }) };
}

/** Turn a provider's 400 into an actionable error: unsupported format or option, unknown voice, or a generic hint. */
function explain(error: unknown, request: SpeechRequest, wire: AudioFormat): unknown {
  if (!(error instanceof DtstError) || error.status !== 400) return error;
  const message = error.message;
  const unsupported = /unsupported|not supported|invalid|expected one of|must be one of/i;
  if (/response_format|\bformat\b/i.test(message) && unsupported.test(message)) {
    return new DtstError(
      "BAD_INPUT",
      message,
      `This endpoint does not offer ${wire}; pick another \`format\` (mp3 is the most widely supported).`,
      error.status,
    );
  }
  const option = /\b(instructions|speed)\b/i.exec(message);
  if (option && unsupported.test(message)) {
    const name = option[1]!.toLowerCase();
    return new DtstError(
      "BAD_INPUT",
      message,
      `This endpoint does not support \`${name}\`; retry without it.`,
      error.status,
    );
  }
  if (/voice|speaker|reference/i.test(message)) {
    return new DtstError(
      "BAD_INPUT",
      message,
      `Voice "${request.voice}" is not available for ${request.model}. list_speech_models shows its voices when the provider publishes them; otherwise use a voice id from the provider's library.`,
      error.status,
    );
  }
  if (error.code === "PROVIDER" && !error.hint) {
    return new DtstError(
      "PROVIDER",
      message,
      "Check that the model does text-to-speech and the voice exists (list_speech_models).",
      error.status,
    );
  }
  return error;
}

function formatFromMime(contentType: string): AudioFormat | undefined {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return "wav";
  if (mime === "audio/ogg" || mime === "audio/opus") return "opus";
  if (mime === "audio/aac" || mime === "audio/mp4") return "aac";
  if (mime === "audio/flac" || mime === "audio/x-flac") return "flac";
  return undefined;
}

async function readText(reference: string, root: string, signal: AbortSignal): Promise<string> {
  const { inputs, skipped } = await loadInputs([reference], { root, signal, maxTextBytes: MAX_TEXT_BYTES });
  const input = inputs[0];
  if (!input) {
    throw badInput(`Could not read ${reference}: ${skipped[0]?.reason ?? "no such file"}.`);
  }
  if (input.kind !== "text") throw badInput(`${reference} is an image, not text.`);
  if (input.truncated) throw badInput(`${reference} is over ${MAX_TEXT_BYTES / 1024} KB; split it into parts.`);
  return input.text;
}

// ── models ─────────────────────────────────────────────────────────────────

interface SpeechModel {
  id: string;
  name?: string;
  voices?: string[];
}

interface ModelsResponse {
  data?: {
    id: string;
    name?: string;
    architecture?: { output_modalities?: string[] };
    supported_voices?: unknown;
  }[];
}

const SPEECH_ID = /tts|speech|voice|audio|kokoro|orpheus|piper|xtts|bark|eleven|sonic/i;

export async function listSpeechModels(config: Config, signal: AbortSignal): Promise<SpeechModel[]> {
  const endpoint = config.openRouter ? "/models?output_modalities=speech" : "/models";
  const { data = [] } = await api<ModelsResponse>(config, endpoint, { signal });
  return data
    .filter((model) =>
      model.architecture?.output_modalities
        ? model.architecture.output_modalities.some((modality) => modality === "speech" || modality === "audio")
        : SPEECH_ID.test(model.id),
    )
    .map((model) => {
      const voices = Array.isArray(model.supported_voices)
        ? model.supported_voices.filter((voice): voice is string => typeof voice === "string")
        : [];
      return { id: model.id, ...(model.name ? { name: model.name } : {}), ...(voices.length ? { voices } : {}) };
    });
}

/** The model's first published voice, when the endpoint lists voices (OpenRouter does). */
async function firstVoice(config: Config, model: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const models = await listSpeechModels(config, signal);
    return models.find((entry) => entry.id === model)?.voices?.[0];
  } catch (error) {
    log.debug("voice lookup failed", String(error));
    return undefined;
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
