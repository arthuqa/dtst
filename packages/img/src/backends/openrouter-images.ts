/**
 * OpenRouter dedicated Image API backend.
 *
 * `POST {baseUrl}/images` takes a flat JSON body (model, prompt, n, size,
 * resolution, aspect_ratio, quality, output_format, background, seed) and
 * returns `{ created, data: [{ b64_json, media_type }], usage }`.
 *
 * Editing/conditioning is expressed with `input_references` (JSON with URL or
 * data-URL entries) rather than multipart. There is no mask parameter.
 */

import {
  type LoadedImage,
  DtstError,
  extractErrorMessage,
  requestJson,
  toChatImagePart,
} from "@dtst/internal";
import { buildPrompt } from "../prompt";
import { ERROR_UNSUPPORTED } from "../errors";
import { resolveImageModel } from "../model";
import { compact, isUnsupportedParameterError, renderedImageFrom } from "./shared";
import { buildModelList } from "./types";
import type {
  BackendCapabilities,
  BackendContext,
  EditRequest,
  GenerateRequest,
  ImageBackend,
  ImageModelInfo,
  ImageResult,
  ModelFilter,
  RenderedImage,
} from "./types";

interface OpenRouterImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string | null; url?: string | null; media_type?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

interface OpenRouterModelListEntry {
  id?: string;
  name?: string;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, unknown> | string[];
  supports_streaming?: boolean;
  endpoints?: unknown[];
}

export class OpenRouterImagesBackend implements ImageBackend {
  readonly kind = "openrouter" as const;
  readonly capabilities: BackendCapabilities = {
    generate: true,
    edit: true,
    mask: false,
    seed: true,
    nativeBatch: true,
    remoteReferences: true,
  };

  async generate(request: GenerateRequest, context: BackendContext): Promise<ImageResult> {
    const model = resolveImageModel(context.config, request.model);

    const body = compact({
      model,
      prompt: buildPrompt(request),
      n: request.n,
      size: request.size,
      resolution: request.resolution,
      aspect_ratio: request.aspectRatio,
      quality: request.quality,
      output_format: request.outputFormat,
      background: request.background,
      output_compression: request.outputCompression,
      seed: request.seed,
      user: request.user,
      stream: false,
    });

    await context.progress.report(0, request.n, `generating ${request.n} image(s) with ${model}`);
    const response = await this.post(body, context);
    const images = await this.decode(response, request, context);
    await context.progress.report(1, 1, "done");
    return this.toResult(response, images, model);
  }

  async edit(request: EditRequest, context: BackendContext): Promise<ImageResult> {
    const model = resolveImageModel(context.config, request.model);
    if (request.images.length === 0) throw ERROR_UNSUPPORTED.needsInputImages();

    const body = compact({
      model,
      prompt: buildPrompt(request),
      n: request.n,
      input_references: request.images.map((image) => toReference(image)),
      size: request.size,
      resolution: request.resolution,
      aspect_ratio: request.aspectRatio,
      quality: request.quality,
      output_format: request.outputFormat,
      background: request.background,
      output_compression: request.outputCompression,
      seed: request.seed,
      user: request.user,
      stream: false,
    });

    await context.progress.report(0, request.n, `editing ${request.images.length} image(s) with ${model}`);
    const response = await this.post(body, context);
    const images = await this.decode(response, request, context);
    await context.progress.report(1, 1, "done");
    return this.toResult(response, images, model);
  }

  async listModels(context: BackendContext, filter: ModelFilter): Promise<ImageModelInfo[]> {
    const response = await requestJson<{ data?: OpenRouterModelListEntry[] }>(`${context.config.baseUrl}/images/models`, {
      signal: context.signal,
      label: "GET /images/models",
      maxRetries: 1,
    });
    const entries = response.json?.data ?? [];
    const models: ImageModelInfo[] = entries.map((entry) => ({
      id: entry.id ?? "unknown",
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.architecture?.input_modalities === undefined ? {} : { inputModalities: entry.architecture.input_modalities }),
      ...(entry.architecture?.output_modalities === undefined ? {} : { outputModalities: entry.architecture.output_modalities }),
      ...(entry.supports_streaming === undefined ? {} : { supportsStreaming: entry.supports_streaming }),
      endpointCount: Array.isArray(entry.endpoints) ? entry.endpoints.length : 0,
      backend: this.kind,
    }));
    return buildModelList(models, filter);
  }

  private async post(body: Record<string, unknown>, context: BackendContext): Promise<OpenRouterImageResponse> {
    try {
      const response = await requestJson<OpenRouterImageResponse>(`${context.config.baseUrl}/images`, {
        body,
        headers: { authorization: `Bearer ${context.config.apiKey}` },
        timeoutMs: context.config.timeoutMs,
        maxRetries: context.config.maxRetries,
        signal: context.signal,
        label: "POST /images",
        maxBytes: 128 * 1024 * 1024,
      });
      return response.json ?? {};
    } catch (error) {
      if (isUnsupportedParameterError(error)) {
        const minimal = { model: body["model"], prompt: body["prompt"], n: body["n"] };
        context.log.warn("OpenRouter rejected optional image parameters; retrying with a minimal body", {
          dropped: Object.keys(body).filter((key) => !(key in minimal)),
        });
        const retry = await requestJson<OpenRouterImageResponse>(`${context.config.baseUrl}/images`, {
          body: minimal,
          headers: { authorization: `Bearer ${context.config.apiKey}` },
          timeoutMs: context.config.timeoutMs,
          maxRetries: context.config.maxRetries,
          signal: context.signal,
          label: "POST /images",
          maxBytes: 128 * 1024 * 1024,
        });
        return retry.json ?? {};
      }
      throw error;
    }
  }

  private async decode(
    response: OpenRouterImageResponse,
    request: GenerateRequest,
    context: BackendContext,
  ): Promise<RenderedImage[]> {
    const entries = response.data ?? [];
    if (entries.length === 0) {
      throw new DtstError("PROVIDER_ERROR", "OpenRouter returned no images.", {
        hint: "The model may not be available on the images API. Try DTST_IMG_BACKEND=chat, or check `list_image_models`.",
      });
    }
    const fallbackMime = request.outputFormat === "jpeg" ? "image/jpeg" : request.outputFormat === "webp" ? "image/webp" : "image/png";
    return Promise.all(
      entries.map(async (entry) => {
        const rendered = await renderedImageFrom(entry, { fallbackMime, signal: context.signal, log: context.log });
        return entry.media_type ? { ...rendered, mimeType: entry.media_type } : rendered;
      }),
    );
  }

  private toResult(response: OpenRouterImageResponse, images: RenderedImage[], model: string): ImageResult {
    const usage = response.usage;
    return {
      images,
      model,
      backend: this.kind,
      ...(response.created === undefined ? {} : { created: response.created }),
      ...(usage === undefined
        ? {}
        : {
            usage: {
              ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
              ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
              ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
              ...(usage.cost === undefined ? {} : { costUsd: usage.cost }),
            },
          }),
    };
  }
}

function toReference(image: LoadedImage): { type: "image_url"; image_url: { url: string } } {
  const part = toChatImagePart(image);
  return { type: "image_url", image_url: { url: part.image_url.url } };
}

export function formatOpenRouterError(response: { status: number; text: string }): string {
  return extractErrorMessage(undefined, response.text) ?? `HTTP ${response.status}`;
}
