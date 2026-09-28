/**
 * Backend selection.
 *
 * `auto` (the default) picks the protocol that the configured endpoint and
 * model actually speak:
 *
 *   OpenRouter host ─┬─ model listed on /images/models with providers → openrouter
 *                    └─ otherwise                                     → chat (modalities)
 *   Any other host   ───────────────────────────────────────────────→ images (OpenAI)
 *
 * A fallback wrapper retries a call on the other protocol when the primary
 * one turns out to be unsupported (404 / "unknown endpoint"), which is the
 * common case for OpenAI-compatible servers that only implement chat.
 */

import {
  DtstError,
  type Logger,
  type ProviderConfig,
  createOpenAIClient,
  extractErrorMessage,
  isDtstError,
  requestJson,
} from "@dtst/internal";
import { ChatModalitiesBackend } from "./chat-modalities";
import { OpenAIImagesBackend } from "./openai-images";
import { OpenRouterImagesBackend } from "./openrouter-images";
import { buildModelList } from "./types";
import type {
  BackendContext,
  EditRequest,
  GenerateRequest,
  ImageBackend,
  ImageModelInfo,
  ImageResult,
  ModelFilter,
} from "./types";

export interface SelectionOptions {
  model?: string | undefined;
  log: Logger;
}

export interface BackendSelection {
  backend: ImageBackend;
  reason: string;
}

export function isOpenRouter(config: ProviderConfig): boolean {
  try {
    return new URL(config.baseUrl).host.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

/** Models with at least one provider on OpenRouter's dedicated images API. */
export async function resolveBackend(
  config: ProviderConfig,
  options: SelectionOptions,
  _signal?: AbortSignal,
): Promise<BackendSelection> {
  const client = createOpenAIClient(config);
  const images = new OpenAIImagesBackend(client);
  const chat = new ChatModalitiesBackend(client);
  const openrouter = new OpenRouterImagesBackend();

  switch (config.imageBackend) {
    case "images":
      return { backend: images, reason: "DTST_IMG_BACKEND=images" };
    case "chat":
      return { backend: chat, reason: "DTST_IMG_BACKEND=chat" };
    case "openrouter":
      return { backend: openrouter, reason: "DTST_IMG_BACKEND=openrouter" };
    default:
      break;
  }

  if (isOpenRouter(config)) {
    // OpenRouter's dedicated images API is the documented route for image
    // models (`POST /images`), while some older models are only reachable
    // through chat completions. The `/images` response tells us precisely
    // which one a given model belongs to, so try it first and fall back.
    return {
      backend: new FallbackBackend(openrouter, chat, options.log),
      reason: `OpenRouter images API (POST ${new URL("/images", config.baseUrl).pathname}) with chat-completions fallback`,
    };
  }

  // Non-OpenRouter: prefer the OpenAI Images API, but fall back to chat when the
  // endpoint does not implement it (common for chat-only proxies).
  return {
    backend: new FallbackBackend(images, chat, options.log),
    reason: "OpenAI images API with chat-modalities fallback",
  };
}

/**
 * Try `primary`, and when it reports "unsupported endpoint", retry with
 * `secondary`. Errors that indicate bad input/auth/model are never masked.
 */
export class FallbackBackend implements ImageBackend {
  constructor(
    private readonly primary: ImageBackend,
    private readonly secondary: ImageBackend,
    private readonly log: Logger,
  ) {}

  get kind(): ImageBackend["kind"] {
    return this.primary.kind;
  }

  get capabilities(): ImageBackend["capabilities"] {
    return { ...this.primary.capabilities, remoteReferences: true };
  }

  async generate(request: GenerateRequest, context: BackendContext): Promise<ImageResult> {
    return this.attempt((backend) => backend.generate(request, context), "generate", request.model);
  }

  async edit(request: EditRequest, context: BackendContext): Promise<ImageResult> {
    return this.attempt((backend) => this.callEdit(backend, request, context), "edit", request.model);
  }

  async listModels(context: BackendContext, filter: ModelFilter): Promise<ImageModelInfo[]> {
    try {
      if (!this.primary.listModels) throw new DtstError("PROVIDER_UNSUPPORTED", "no model listing");
      return await this.primary.listModels(context, filter);
    } catch {
      if (!this.secondary.listModels) return [];
      try {
        return await this.secondary.listModels(context, filter);
      } catch {
        return [];
      }
    }
  }

  private async callEdit(backend: ImageBackend, request: EditRequest, context: BackendContext): Promise<ImageResult> {
    if (!backend.edit) {
      throw new DtstError("PROVIDER_UNSUPPORTED", `The ${backend.kind} backend cannot edit images.`);
    }
    return backend.edit(request, context);
  }

  private async attempt(
    call: (backend: ImageBackend) => Promise<ImageResult>,
    operation: "generate" | "edit",
    model: string | undefined,
  ): Promise<ImageResult> {
    try {
      return await call(this.primary);
    } catch (error) {
      if (!isEndpointUnsupported(error)) throw error;
      this.log.warn("primary image protocol unsupported by the endpoint; retrying over chat completions", {
        operation,
        model,
        message: error instanceof Error ? error.message : String(error),
      });
      return call(this.secondary);
    }
  }
}

export function isEndpointUnsupported(error: unknown): boolean {
  if (!isDtstError(error)) return false;
  const message = error.message;
  // OpenRouter is explicit when a model belongs to the other route:
  // "<model> cannot be used with the chat/completions endpoint. Use the
  //  /api/v1/images endpoint instead."
  if (/cannot be used with|use the \S*images endpoint instead|use the .*chat\/completions endpoint instead/i.test(message)) {
    return true;
  }
  if (error.status === 404 || error.status === 405 || error.status === 501) return true;
  if (error.code === "PROVIDER_UNSUPPORTED") return true;
  if (error.status === 400 || error.status === 422) {
    return /unknown (endpoint|route|url|path)|not (found|supported|implemented)|unsupported|no such/i.test(message);
  }
  return false;
}

export async function listImageModels(
  config: ProviderConfig,
  filter: ModelFilter,
  context: { log: Logger; signal: AbortSignal; progress: BackendContext["progress"] },
): Promise<{ models: ImageModelInfo[]; backend: string; note?: string }> {
  const backendContext: BackendContext = { config, log: context.log, progress: context.progress, signal: context.signal };

  if (config.imageBackend === "auto" && isOpenRouter(config)) {
    const models = new Map<string, ImageModelInfo>();
    let note: string | undefined;

    // Authoritative list for the dedicated images API.
    try {
      const openrouter = new OpenRouterImagesBackend();
      for (const model of await openrouter.listModels(backendContext, { query: undefined, limit: 500 })) {
        models.set(model.id, model);
      }
    } catch (error) {
      context.log.debug("OpenRouter /images/models failed", { error });
    }

    // Image-output models reachable through chat completions.
    try {
      const chatContext: BackendContext = { config, log: context.log, progress: context.progress, signal: context.signal };
      const chat = new ChatModalitiesBackend(createOpenAIClient(config));
      const chatModels = await listOpenRouterChatImageModels(config, chatContext);
      for (const model of chatModels) {
        const existing = models.get(model.id);
        if (existing) {
          models.set(model.id, { ...existing, backend: existing.backend ?? model.backend });
        } else {
          models.set(model.id, { ...model, backend: model.backend ?? "chat" });
        }
      }
      void chat;
    } catch (error) {
      context.log.debug("OpenRouter /models listing failed", { error });
    }

    if (models.size === 0) {
      note = "Neither /images/models nor /models returned image-capable models.";
    } else {
      note =
        "Models listed by /images/models are attempted on the dedicated images API first, then fall back to chat completions. Provider counts can lag reality, so a model showing 0 providers may still work.";
    }
    const merged = buildModelList([...models.values()], filter);
    return merged.length > 0
      ? { models: merged, backend: "openrouter", ...(note === undefined ? {} : { note }) }
      : { models: [], backend: "openrouter", ...(note === undefined ? {} : { note }) };
  }

  const selection = await resolveBackend(config, { log: context.log, ...(filter.query ? { model: filter.query } : {}) }, context.signal);
  const backend = selection.backend;
  if (!backend.listModels) {
    throw new DtstError("PROVIDER_UNSUPPORTED", `The ${backend.kind} backend cannot list models.`);
  }
  const models = await backend.listModels(backendContext, filter);
  return { models, backend: backend.kind };
}

/** `GET /models?output_modalities=image` — image-output models on OpenRouter. */
async function listOpenRouterChatImageModels(config: ProviderConfig, context: BackendContext): Promise<ImageModelInfo[]> {
  const response = await requestJson<{
    data?: Array<{
      id?: string;
      name?: string;
      description?: string;
      architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    }>;
  }>(`${config.baseUrl}/models?output_modalities=image`, {
    signal: context.signal,
    label: "GET /models?output_modalities=image",
    maxRetries: 1,
    timeoutMs: 20_000,
  });
  return (response.json?.data ?? [])
    .filter((model): model is { id: string } & typeof model => typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      backend: "chat" as const,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      outputModalities: model.architecture?.output_modalities ?? ["image"],
      ...(model.architecture?.input_modalities === undefined ? {} : { inputModalities: model.architecture.input_modalities }),
    }));
}

export function describeSelection(selection: BackendSelection): string {
  return `${selection.backend.kind} (${selection.reason})`;
}

export function formatProviderError(error: unknown): string {
  if (isDtstError(error)) return error.format();
  if (error instanceof Error) return error.message;
  return extractErrorMessage(undefined, String(error)) ?? String(error);
}

export { buildModelList };
