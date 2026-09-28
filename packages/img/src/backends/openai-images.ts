/**
 * OpenAI Images API backend: `POST /images/generations` and `POST /images/edits`
 * (multipart). This is what OpenAI, Azure-compatible gateways and most
 * LiteLLM/vLLM-style proxies speak.
 */

import type OpenAI from "openai";
import type {
  ImageEditParamsBase,
  ImageEditParamsNonStreaming,
  ImageGenerateParamsBase,
  ImageGenerateParamsNonStreaming,
  ImagesResponse,
} from "openai/resources/images";
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
import { buildModelList } from "./types";
import { ERROR_UNSUPPORTED } from "../errors";
import { resolveImageModel } from "../model";
import { compact, isUnsupportedParameterError, mimeFromOutputFormat, renderedImageFrom, toUploadable } from "./shared";
import { buildPrompt } from "../prompt";
import { createOpenAIClient } from "@dtst/internal";

export class OpenAIImagesBackend implements ImageBackend {
  readonly kind = "images" as const;
  readonly capabilities: BackendCapabilities = {
    generate: true,
    edit: true,
    mask: true,
    seed: false,
    nativeBatch: true,
    remoteReferences: false,
  };

  constructor(private readonly client: OpenAI) {}

  async generate(request: GenerateRequest, context: BackendContext): Promise<ImageResult> {
    const model = resolveImageModel(context.config, request.model);

    const full = compact({
      model,
      prompt: buildPrompt(request),
      n: request.n,
      size: request.size,
      quality: request.quality,
      output_format: request.outputFormat,
      background: request.background,
      output_compression: request.outputCompression,
      // GPT image models always return b64; DALL-E 2/3 honour the flag.
      response_format: "b64_json" as const,
      user: request.user,
    });

    await context.progress.report(0, request.n, `generating ${request.n} image(s) with ${model}`);
    const response = await this.callWithFallback<ImagesResponse>(
      (body) =>
        this.client.images.generate(body as ImageGenerateParamsNonStreaming, {
          signal: context.signal,
        }) as Promise<ImagesResponse>,
      full,
      context,
    );
    const images = await this.toImages(response, request, context);
    await context.progress.report(1, 1, "done");
    return this.toResult(response, images, model, context, request.n);
  }

  async edit(request: EditRequest, context: BackendContext): Promise<ImageResult> {
    const model = resolveImageModel(context.config, request.model);
    if (request.images.length === 0) throw ERROR_UNSUPPORTED.needsInputImages();

    const uploadables = await Promise.all(request.images.map((image, index) => toUploadable(image, index)));

    const full = compact({
      model,
      prompt: buildPrompt(request),
      image: uploadables.length === 1 ? uploadables[0] : uploadables,
      mask: request.mask ? await toUploadable(request.mask, 0) : undefined,
      n: request.n,
      size: request.size,
      quality: request.quality,
      input_fidelity: request.inputFidelity,
      output_format: request.outputFormat,
      background: request.background,
      output_compression: request.outputCompression,
      response_format: "b64_json" as const,
      user: request.user,
      stream: false as const,
    });

    await context.progress.report(0, request.n, `editing with ${model}`);
    const response = await this.callWithFallback<ImagesResponse>(
      (body) =>
        this.client.images.edit(body as ImageEditParamsNonStreaming, {
          signal: context.signal,
        }) as Promise<ImagesResponse>,
      full,
      context,
    );
    const images = await this.toImages(response, request, context);
    await context.progress.report(1, 1, "done");
    return this.toResult(response, images, model, context, request.n);
  }

  async listModels(context: BackendContext, filter: ModelFilter): Promise<ImageModelInfo[]> {
    const models = await this.client.models.list({ signal: context.signal });
    const ids = models.data.map((model) => model.id);
    const imageish = ids.filter((id) =>
      /image|dall-?e|flux|stable-diffusion|sdxl|imagen|seedream|qwen-image|gpt-image/i.test(id),
    );
    const selected = imageish.length > 0 ? imageish : ids;
    return buildModelList(
      selected.map((id) => ({ id, outputModalities: ["image"], backend: this.kind })),
      filter,
    );
  }

  private async callWithFallback<T>(
    call: (body: ImageGenerateParamsBase | ImageEditParamsBase) => Promise<T>,
    fullBody: Record<string, unknown>,
    context: BackendContext,
  ): Promise<T> {
    try {
      return await call(fullBody as unknown as ImageGenerateParamsBase);
    } catch (error) {
      if (!isUnsupportedParameterError(error)) throw error;
      const model = String(fullBody["model"] ?? "");
      const minimal = compact({
        model,
        prompt: fullBody["prompt"] as string,
        n: fullBody["n"] as number,
        size: fullBody["size"] as string | undefined,
      });
      if (Object.keys(minimal).length === Object.keys(fullBody).length) throw error;
      context.log.warn("provider rejected optional parameters; retrying with a minimal body", {
        model,
        dropped: Object.keys(fullBody).filter((key) => !(key in minimal)),
      });
      return await call(minimal as ImageGenerateParamsBase | ImageEditParamsBase);
    }
  }

  private async toImages(
    response: ImagesResponse,
    request: GenerateRequest,
    context: BackendContext,
  ): Promise<RenderedImage[]> {
    const fallbackMime = mimeFromOutputFormat(request.outputFormat, "image/png");
    const entries = response.data ?? [];
    if (entries.length === 0) throw ERROR_UNSUPPORTED.emptyResponse();
    return Promise.all(
      entries.map((entry) => renderedImageFrom(entry, { fallbackMime, signal: context.signal, log: context.log })),
    );
  }

  private toResult(
    response: ImagesResponse,
    images: RenderedImage[],
    model: string,
    _context: BackendContext,
    _requested: number,
  ): ImageResult {
    const usage = response.usage;
    return {
      images,
      model,
      backend: this.kind,
      created: response.created,
      ...(usage
        ? {
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            },
          }
        : {}),
    };
  }
}

export function createOpenAIImagesBackend(config: Parameters<typeof createOpenAIClient>[0]): OpenAIImagesBackend {
  return new OpenAIImagesBackend(createOpenAIClient(config));
}
