/**
 * Chat-completions image backend.
 *
 * Some providers (notably OpenRouter-hosted image models such as
 * `meta/muse-image`) only expose image output through `/chat/completions`
 * with `modalities: ["image","text"]`. This backend speaks that protocol:
 *
 *   request  → messages with optional `image_url` parts + `modalities`
 *              + provider-specific `image_config`
 *   response → `choices[0].message.images[] = [{ image_url: { url } }]`
 *
 * `n` is emulated with sequential calls because the protocol has no batch
 * parameter; progress is reported after each image.
 */

import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { DtstError, type LoadedImage, toChatImagePart } from "@dtst/internal";
import { composeChatPrompt, buildPrompt } from "../prompt";
import { ERROR_UNSUPPORTED } from "../errors";
import { compact, isUnsupportedParameterError, parseDataUrlSafe, renderedImageFrom } from "./shared";
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
  Usage,
} from "./types";

export type ChatImageBody = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
  modalities?: Array<"text" | "image" | "audio">;
  image_config?: Record<string, unknown>;
};

interface AssistantImageEntry {
  image_url?: { url?: string | null } | null;
  url?: string | null;
  b64_json?: string | null;
  media_type?: string | null;
}

export class ChatModalitiesBackend implements ImageBackend {
  readonly kind = "chat" as const;
  readonly capabilities: BackendCapabilities = {
    generate: true,
    edit: true,
    mask: false,
    seed: false,
    nativeBatch: false,
    remoteReferences: true,
  };

  constructor(private readonly client: OpenAI) {}

  async generate(request: GenerateRequest, context: BackendContext): Promise<ImageResult> {
    const model = request.model ?? context.config.imageModel;
    if (!model) throw ERROR_UNSUPPORTED.missingModel();
    return this.runBatch(request, context, model, []);
  }

  async edit(request: EditRequest, context: BackendContext): Promise<ImageResult> {
    const model = request.model ?? context.config.imageModel;
    if (!model) throw ERROR_UNSUPPORTED.missingModel();
    if (request.images.length === 0) throw ERROR_UNSUPPORTED.needsInputImages();
    return this.runBatch(request, context, model, request.images);
  }

  async listModels(context: BackendContext, filter: ModelFilter): Promise<ImageModelInfo[]> {
    const models = await this.client.models.list({ signal: context.signal });
    const imageModels: ImageModelInfo[] = models.data.map((model) => ({
      id: model.id,
      backend: this.kind,
      ...(looksLikeImageModel(model.id) ? { outputModalities: ["image"] } : { outputModalities: ["text"] }),
    }));
    return buildModelList(imageModels, filter);
  }

  /**
   * `modalities: ["image"]` is an OpenRouter (and compatible-proxy) extension
   * that the OpenAI SDK's types do not model, so the body is cast here at the
   * single boundary where the request leaves the process.
   */
  private async createChatCompletion(body: ChatImageBody, signal: AbortSignal): Promise<ChatCompletion> {
    return (await this.client.chat.completions.create(
      body as unknown as ChatCompletionCreateParamsNonStreaming,
      { signal },
    )) as ChatCompletion;
  }

  private async runBatch(
    request: GenerateRequest,
    context: BackendContext,
    model: string,
    inputImages: readonly LoadedImage[],
  ): Promise<ImageResult> {
    const total = Math.max(1, request.n);
    const images: RenderedImage[] = [];
    const notes: string[] = [];
    const usage: Usage = {};
    let created: number | undefined;
    let failure: unknown;

    await context.progress.report(0, total, `generating ${total} image(s) with ${model}`);
    for (let index = 0; index < total; index += 1) {
      try {
        const result = await this.callOnce(request, context, model, inputImages);
        images.push(...result.images);
        if (result.notes) notes.push(result.notes);
        mergeUsage(usage, result.usage);
        created ??= result.created;
      } catch (error) {
        failure = error;
        context.log.warn("chat image call failed", { index, total, message: error instanceof Error ? error.message : String(error) });
        break;
      }
      await context.progress.report(index + 1, total, `${index + 1}/${total} image(s)`);
    }

    if (images.length === 0) {
      throw failure ?? ERROR_UNSUPPORTED.emptyResponse();
    }
    if (failure && images.length < total) {
      notes.push(
        `Only ${images.length} of ${total} requested images were produced; the provider failed on image ${images.length + 1} (${
          failure instanceof Error ? failure.message : String(failure)
        }).`,
      );
    }
    if (total > 1) notes.push(`This backend has no batch parameter, so the images were generated in ${total} sequential calls.`);

    return {
      images,
      model,
      backend: this.kind,
      ...(created === undefined ? {} : { created }),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(notes.length > 0 ? { notes: notes.join(" ") } : {}),
    };
  }

  private async callOnce(
    request: GenerateRequest,
    context: BackendContext,
    model: string,
    inputImages: readonly LoadedImage[],
  ): Promise<{ images: RenderedImage[]; notes?: string; usage?: Usage; created?: number }> {
    const content: Array<Record<string, unknown>> = [];
    for (const image of inputImages) {
      content.push({ ...toChatImagePart(image) });
    }
    content.push({
      type: "text",
      text:
        inputImages.length > 0
          ? buildPrompt(request)
          : composeChatPrompt(request),
    });

    const imageConfig = compact({
      size: request.size,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
      quality: request.quality,
      background: request.background,
      output_format: request.outputFormat,
    });

    const body: ChatImageBody = {
      model,
      messages: [{ role: "user", content: content as never }],
      modalities: ["image", "text"],
      ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
    };

    let response: ChatCompletion;
    try {
      response = await this.createChatCompletion(body, context.signal);
    } catch (error) {
      if (!isUnsupportedParameterError(error)) throw error;
      context.log.warn("provider rejected image_config/modalities extras; retrying with the bare minimum", { model });
      delete body.image_config;
      response = await this.createChatCompletion({ model, messages: body.messages, modalities: ["image"] }, context.signal);
    }

    const message = response.choices?.[0]?.message as
      | { content?: string | null; images?: AssistantImageEntry[] }
      | undefined;
    const entries: AssistantImageEntry[] = Array.isArray(message?.images) ? message.images : [];
    const fallbackMime = request.outputFormat === "jpeg" ? "image/jpeg" : request.outputFormat === "webp" ? "image/webp" : "image/png";

    const images: RenderedImage[] = [];
    for (const entry of entries) {
      // The wire shape is `{ image_url: { url } }`; `renderedImageFrom` speaks
      // the OpenAI image-entry shape (`url`), so unwrap it here.
      const normalized = { ...entry, url: entry.url ?? entry.image_url?.url ?? null };
      images.push(await renderedImageFrom(normalized, { fallbackMime, signal: context.signal, log: context.log }));
    }

    const text = typeof message?.content === "string" ? message.content.trim() : "";
    if (images.length === 0 && text) {
      // Some proxies inline the image as a data URL in the text instead of
      // the structured `images` array.
      const inline = extractInlineImages(text);
      if (inline.length > 0) {
        for (const dataUrl of inline) {
          const parsed = parseDataUrlSafe(dataUrl);
          if (!parsed) continue;
          images.push({ data: parsed.data, mimeType: parsed.mimeType });
        }
      }
    }
    if (images.length === 0) {
      const providerMessage = text ? ` Provider said: ${text.slice(0, 300)}` : "";
      throw new DtstError("PROVIDER_ERROR", `The model did not return an image.${providerMessage}`, {
        hint: "Check that the model produces images and that `modalities: [\"image\",\"text\"]` is supported. `list_image_models` shows candidates.",
      });
    }

    const usage = response.usage;
    return {
      images,
      ...(text ? { notes: `Model note: ${text.slice(0, 500)}` } : {}),
      created: response.created,
      ...(usage
        ? {
            usage: {
              ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
              ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
              ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
            },
          }
        : {}),
    };
  }
}

function extractInlineImages(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g)) {
    urls.push(match[0]);
  }
  return urls;
}

function looksLikeImageModel(id: string): boolean {
  return /image|dall-?e|flux|diffusion|sd-?\d|imagen|seedream|muse|canvas|paint/i.test(id);
}

function mergeUsage(target: Usage, source: Usage | undefined): void {
  if (!source) return;
  if (source.inputTokens !== undefined) target.inputTokens = (target.inputTokens ?? 0) + source.inputTokens;
  if (source.outputTokens !== undefined) target.outputTokens = (target.outputTokens ?? 0) + source.outputTokens;
  if (source.totalTokens !== undefined) target.totalTokens = (target.totalTokens ?? 0) + source.totalTokens;
  if (source.costUsd !== undefined) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
}

export function createChatBackend(client: OpenAI): ChatModalitiesBackend {
  return new ChatModalitiesBackend(client);
}
