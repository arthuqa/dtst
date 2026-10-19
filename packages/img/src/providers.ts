/**
 * Three wire protocols cover "any OpenAI-compatible API" for images:
 *
 *   images      POST /images/generations, /images/edits (multipart)   OpenAI, LiteLLM, most gateways
 *   openrouter  POST /images  (JSON, input_references)                OpenRouter
 *   chat        POST /chat/completions with modalities: [image,text]  chat-only image models
 *
 * `auto` picks openrouter on openrouter.ai and images elsewhere, then falls back to chat when
 * the endpoint or model does not exist on the first route.
 */

import {
  type Config,
  DtstError,
  type ImageApi,
  type ImageInput,
  api,
  download,
  log,
  parseDataUrl,
  sniffImage,
  toDataUrl,
} from "@dtst/internal";

export type Route = Exclude<ImageApi, "auto">;

export interface ImageRequest {
  model: string;
  prompt: string;
  n: number;
  size?: string | undefined;
  aspectRatio?: string | undefined;
  quality?: string | undefined;
  format?: "png" | "jpeg" | "webp" | undefined;
  background?: "auto" | "transparent" | "opaque" | undefined;
  seed?: number | undefined;
  images?: ImageInput[];
  mask?: ImageInput | undefined;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  route: Route;
  costUsd?: number;
  notes: string[];
}

export interface ProviderContext {
  config: Config;
  signal: AbortSignal;
  progress(message: string): Promise<void>;
}

/** OpenRouter resolution tiers ("1K", "2K", "4K", …) passed through `size`. */
const TIER = /^(\d+(\.\d+)?k|512|768)$/i;
const PIXELS = /^(\d+)x(\d+)$/i;

export async function createImages(request: ImageRequest, context: ProviderContext): Promise<ImageResult> {
  const { imageApi, openRouter } = context.config;
  const primary: Route = imageApi !== "auto" ? imageApi : openRouter ? "openrouter" : "images";
  if (request.mask && primary !== "images") {
    throw new DtstError(
      "BAD_INPUT",
      "`mask` is only supported by the OpenAI images API (/images/edits).",
      "Describe the region to change in `prompt` instead, or set DTST_IMAGE_API=images.",
    );
  }
  try {
    return await ROUTES[primary](request, context);
  } catch (error) {
    if (imageApi !== "auto" || request.mask || !isWrongRoute(error)) throw notAnImageModel(error, request.model);
    log.debug(`${primary} route rejected ${request.model}; retrying over chat completions`, String(error));
    try {
      return await chat(request, context);
    } catch (fallback) {
      throw notAnImageModel(fallback, request.model);
    }
  }
}

const ROUTES: Record<Route, (request: ImageRequest, context: ProviderContext) => Promise<ImageResult>> = {
  images: openaiImages,
  openrouter: openrouterImages,
  chat,
};

async function openaiImages(request: ImageRequest, { config, signal }: ProviderContext): Promise<ImageResult> {
  const notes: string[] = [];
  if (request.size && TIER.test(request.size)) notes.push(`size "${request.size}" ignored: this API takes WxH.`);
  if (request.seed !== undefined) notes.push("seed ignored: not supported by the images API.");
  const body = compact({
    model: request.model,
    prompt: request.prompt,
    n: request.n,
    size: pixelSize(request),
    quality: request.quality,
    output_format: request.format,
    background: request.background,
    // GPT image models always return base64 and reject this field; DALL·E defaults to URLs.
    response_format: /^dall-e/i.test(request.model) ? "b64_json" : undefined,
  });

  let response: ImagesResponse;
  if (request.images?.length) {
    body["image"] = request.images.map(blob);
    if (request.mask) body["mask"] = blob(request.mask);
    response = await sendWithFallback(body, ["model", "prompt", "n", "image", "mask"], notes, (payload) =>
      api(config, "/images/edits", { form: toForm(payload), signal }),
    );
  } else {
    response = await sendWithFallback(body, ["model", "prompt", "n"], notes, (payload) =>
      api(config, "/images/generations", { json: payload, signal }),
    );
  }
  return { images: await decodeAll(response.data, signal), route: "images", notes };
}

async function openrouterImages(request: ImageRequest, { config, signal }: ProviderContext): Promise<ImageResult> {
  const notes: string[] = [];
  const tier = request.size && TIER.test(request.size) ? request.size.toUpperCase() : undefined;
  const body = compact({
    model: request.model,
    prompt: request.prompt,
    n: request.n,
    size: tier ? undefined : request.size,
    resolution: tier,
    aspect_ratio: request.aspectRatio,
    quality: request.quality,
    output_format: request.format,
    background: request.background,
    seed: request.seed,
    input_references: request.images?.length ? request.images.map(imagePart) : undefined,
  });
  const response = await sendWithFallback(body, ["model", "prompt", "n", "input_references"], notes, (payload) =>
    api<ImagesResponse>(config, "/images", { json: payload, signal }),
  );
  const cost = response.usage?.cost;
  return {
    images: await decodeAll(response.data, signal),
    route: "openrouter",
    notes,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

/** Chat completions have no batch parameter, so `n` means n sequential calls. */
async function chat(request: ImageRequest, { config, signal, progress }: ProviderContext): Promise<ImageResult> {
  const notes: string[] = [];
  const tier = request.size && TIER.test(request.size) ? request.size.toUpperCase() : undefined;
  const imageConfig = compact({ aspect_ratio: request.aspectRatio ?? ratioOf(request.size), image_size: tier });
  const body = compact({
    model: request.model,
    messages: [
      {
        role: "user",
        content: [...(request.images ?? []).map(imagePart), { type: "text", text: request.prompt }],
      },
    ],
    modalities: ["image", "text"],
    image_config: Object.keys(imageConfig).length > 0 ? imageConfig : undefined,
    seed: request.seed,
  });

  const images: GeneratedImage[] = [];
  let costUsd: number | undefined;
  for (let index = 0; index < request.n; index += 1) {
    try {
      const response = await sendWithFallback(body, ["model", "messages", "modalities"], notes, (payload) =>
        api<ChatResponse>(config, "/chat/completions", { json: payload, signal }),
      );
      const message = response.choices?.[0]?.message;
      const urls = (message?.images ?? []).map((entry) => entry.image_url?.url ?? entry.url ?? "").filter(Boolean);
      const content = typeof message?.content === "string" ? message.content : "";
      urls.push(...(content.match(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/g) ?? []));
      if (urls.length === 0) {
        throw new DtstError(
          "UNSUPPORTED",
          `${request.model} replied with text instead of an image: ${content.slice(0, 200)}`,
        );
      }
      images.push(
        ...(await decodeAll(
          urls.map((url) => ({ url })),
          signal,
        )),
      );
      if (typeof response.usage?.cost === "number") costUsd = (costUsd ?? 0) + response.usage.cost;
      if (request.n > 1) await progress(`${index + 1}/${request.n} images`);
    } catch (error) {
      if (images.length === 0) throw error;
      notes.push(`Only ${images.length} of ${request.n} images were produced: ${String(error)}`);
      break;
    }
  }
  return { images, route: "chat", notes, ...(costUsd === undefined ? {} : { costUsd }) };
}

// ── models ────────────────────────────────────────────────────────────────

export interface ImageModel {
  id: string;
  name?: string;
  route: Route;
  /** Compact summary of supported parameters, when the provider publishes them. */
  params?: string;
}

const IMAGE_ID = /image|dall-?e|flux|diffusion|sdxl|imagen|seedream|recraft|ideogram|muse/i;

export async function listImageModels(config: Config, signal: AbortSignal): Promise<ImageModel[]> {
  const openRouterApi = config.imageApi === "openrouter" || (config.imageApi === "auto" && config.openRouter);
  if (!openRouterApi) {
    const { data = [] } = await api<ModelsResponse>(config, "/models", { signal });
    return data
      .filter((model) =>
        model.architecture?.output_modalities
          ? model.architecture.output_modalities.includes("image")
          : IMAGE_ID.test(model.id),
      )
      .map((model) => ({ id: model.id, route: config.imageApi === "chat" ? "chat" : "images", ...named(model) }));
  }

  // OpenRouter: /images/models is authoritative for the images API (with parameters);
  // /models?output_modalities=image adds models that are only reachable over chat.
  const [images, chatModels] = await Promise.allSettled([
    api<ModelsResponse>(config, "/images/models", { signal }),
    api<ModelsResponse>(config, "/models?output_modalities=image", { signal }),
  ]);
  if (images.status === "rejected" && chatModels.status === "rejected") throw images.reason;
  const models = new Map<string, ImageModel>();
  for (const model of images.status === "fulfilled" ? (images.value.data ?? []) : []) {
    const params = describeParams(model.supported_parameters);
    models.set(model.id, { id: model.id, route: "openrouter", ...named(model), ...(params ? { params } : {}) });
  }
  for (const model of chatModels.status === "fulfilled" ? (chatModels.value.data ?? []) : []) {
    if (!models.has(model.id) && !model.id.startsWith("openrouter/")) {
      models.set(model.id, { id: model.id, route: "chat", ...named(model) });
    }
  }
  return [...models.values()];
}

function named(model: { name?: string }): { name?: string } {
  return model.name ? { name: model.name } : {};
}

function describeParams(parameters: SupportedParameters | undefined): string | undefined {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  const parts = Object.entries(parameters).map(([name, spec]) => {
    if (spec?.type === "enum" && Array.isArray(spec.values)) return `${name}: ${spec.values.join("|")}`;
    if (spec?.type === "range") return `${name}: ${spec.min}–${spec.max}`;
    return name;
  });
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// ── helpers ───────────────────────────────────────────────────────────────

interface ImagesResponse {
  data?: { b64_json?: string | null; url?: string | null }[];
  usage?: { cost?: number };
}

interface ChatResponse {
  choices?: {
    message?: { content?: unknown; images?: { image_url?: { url?: string }; url?: string }[] };
  }[];
  usage?: { cost?: number };
}

interface ModelsResponse {
  data?: {
    id: string;
    name?: string;
    architecture?: { output_modalities?: string[] };
    supported_parameters?: SupportedParameters;
  }[];
}

type SupportedParameters = Record<string, { type?: string; values?: unknown[]; min?: number; max?: number }> | string[];

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function pixelSize(request: ImageRequest): string | undefined {
  if (request.size && (PIXELS.test(request.size) || request.size === "auto")) return request.size;
  const ratio = request.aspectRatio ? ratioValue(request.aspectRatio) : undefined;
  if (ratio === undefined) return undefined;
  // The sizes every GPT image model accepts.
  return ratio > 1.1 ? "1536x1024" : ratio < 0.9 ? "1024x1536" : "1024x1024";
}

function ratioValue(ratio: string): number | undefined {
  const [w, h] = ratio.split(":").map(Number);
  return w && h ? w / h : undefined;
}

function ratioOf(size: string | undefined): string | undefined {
  const match = size ? PIXELS.exec(size) : null;
  if (!match) return undefined;
  const [w, h] = [Number(match[1]), Number(match[2])];
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}

function imagePart(image: ImageInput): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url", image_url: { url: toDataUrl(image.mimeType, image.data) } };
}

function blob(image: ImageInput): File {
  const name = image.source.split(/[/\\]/).pop() || "image";
  return new File([new Uint8Array(image.data)], name, { type: image.mimeType });
}

/** Multipart body; several images use the `image[]` field, as OpenAI's API expects. */
function toForm(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      for (const item of value) form.append(value.length > 1 ? `${key}[]` : key, item as File);
    } else if (value instanceof File) {
      form.append(key, value);
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

/**
 * Providers differ in which optional fields they accept. When one is rejected, retry once
 * with only the essential fields and tell the caller what was dropped.
 */
async function sendWithFallback<T>(
  body: Record<string, unknown>,
  essentials: string[],
  notes: string[],
  send: (body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  try {
    return await send(body);
  } catch (error) {
    const dropped = Object.keys(body).filter((key) => !essentials.includes(key));
    if (dropped.length === 0 || !isParameterError(error)) throw error;
    const minimal = Object.fromEntries(Object.entries(body).filter(([key]) => essentials.includes(key)));
    const result = await send(minimal);
    if (!notes.some((note) => note.startsWith("Provider rejected"))) {
      notes.push(`Provider rejected optional parameters; retried without: ${dropped.join(", ")}.`);
    }
    return result;
  }
}

function isParameterError(error: unknown): boolean {
  return (
    error instanceof DtstError &&
    (error.status === 400 || error.status === 422) &&
    /unknown (parameter|field|argument)|unrecognized|unsupported (parameter|field|value|option)|not supported|invalid (parameter|value|option)|extra (field|input)|unexpected (property|field|keyword)/i.test(
      error.message,
    )
  );
}

/** 404-ish answers (no such endpoint / model on this route) or explicit "use the other endpoint". */
function isWrongRoute(error: unknown): boolean {
  if (!(error instanceof DtstError)) return false;
  return error.code === "UNSUPPORTED" || /cannot be used with|endpoint instead/i.test(error.message);
}

/** Turn "no such model / no image output" answers into one actionable message. */
function notAnImageModel(error: unknown, model: string): unknown {
  if (!(error instanceof DtstError)) return error;
  const hint = "Set OPENAI_IMAGE_MODEL to an image model or pass `model`; list_image_models shows what is available.";
  if (/output modalities|replied with text/i.test(error.message)) {
    return new DtstError("UNSUPPORTED", `"${model}" does not generate images (${error.message})`, hint, error.status);
  }
  if (/no model found|not a valid model/i.test(error.message)) {
    return new DtstError("UNSUPPORTED", `Unknown model "${model}" (${error.message})`, hint, error.status);
  }
  return error;
}

async function decodeAll(
  entries: readonly { b64_json?: string | null; url?: string | null }[] | undefined,
  signal: AbortSignal,
): Promise<GeneratedImage[]> {
  if (!entries?.length)
    throw new DtstError("PROVIDER", "The provider returned no images.", "Retry, or try another model.");
  return Promise.all(
    entries.map(async (entry) => {
      let data: Buffer;
      if (entry.b64_json) data = Buffer.from(entry.b64_json, "base64");
      else if (entry.url?.startsWith("data:")) data = parseDataUrl(entry.url)?.data ?? Buffer.alloc(0);
      else if (entry.url) data = (await download(entry.url, { maxBytes: 64 * 1024 * 1024, signal })).data;
      else throw new DtstError("PROVIDER", "The provider returned an image entry without data.");
      const mimeType = sniffImage(data);
      if (!mimeType) throw new DtstError("PROVIDER", "The provider returned data that is not an image.");
      return { data, mimeType };
    }),
  );
}
