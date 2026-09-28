/**
 * Backend contract for image generation and editing.
 *
 * Three wire protocols exist in the wild and all three are needed for
 * "any OpenAI-compatible API" to be true:
 *
 *  - `images`     → OpenAI's `/images/generations` + `/images/edits`
 *                   (OpenAI, Azure-compatible gateways, LiteLLM, ...)
 *  - `openrouter` → OpenRouter's dedicated `POST /images` (prompt + optional
 *                   `input_references`; no multipart, no mask)
 *  - `chat`       → image output through `/chat/completions` with a
 *                   `modalities: ["image","text"]` request; the only route
 *                   many providers expose (e.g. meta/muse-image on OpenRouter)
 */

import type { LoadedImage, Logger, ProgressReporter, ProviderConfig } from "@dtst/internal";

export type BackendKind = "images" | "openrouter" | "chat";

export interface BackendContext {
  config: ProviderConfig;
  log: Logger;
  progress: ProgressReporter;
  signal: AbortSignal;
}

export interface RenderedImage {
  data: Buffer;
  mimeType: string;
  revisedPrompt?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface GenerateRequest {
  prompt: string;
  model?: string;
  n: number;
  size?: string;
  resolution?: string;
  aspectRatio?: string;
  quality?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "transparent" | "opaque" | "auto";
  outputCompression?: number;
  seed?: number;
  negativePrompt?: string;
  style?: string;
  user?: string;
}

export interface EditRequest extends GenerateRequest {
  images: LoadedImage[];
  mask?: LoadedImage;
  inputFidelity?: "high" | "low";
}

export interface ImageResult {
  images: RenderedImage[];
  model: string;
  backend: BackendKind;
  usage?: Usage;
  notes?: string;
  created?: number;
}

export interface ImageModelInfo {
  id: string;
  name?: string;
  description?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  supportsStreaming?: boolean;
  endpointCount?: number;
  backend?: BackendKind;
}

export interface ModelFilter {
  query?: string;
  limit: number;
}

export interface BackendCapabilities {
  generate: boolean;
  edit: boolean;
  mask: boolean;
  seed: boolean;
  /** Whether `n > 1` is handled natively (chat backends loop instead). */
  nativeBatch: boolean;
  /** Whether input images may be given as URLs as well as bytes. */
  remoteReferences: boolean;
}

export interface ImageBackend {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;
  generate(request: GenerateRequest, context: BackendContext): Promise<ImageResult>;
  edit?(request: EditRequest, context: BackendContext): Promise<ImageResult>;
  listModels?(context: BackendContext, filter: ModelFilter): Promise<ImageModelInfo[]>;
}

export function buildModelList(result: ImageModelInfo[], filter: ModelFilter): ImageModelInfo[] {
  const query = filter.query?.trim().toLowerCase();
  const filtered = query
    ? result.filter(
        (model) =>
          model.id.toLowerCase().includes(query) ||
          (model.name ?? "").toLowerCase().includes(query) ||
          (model.description ?? "").toLowerCase().includes(query),
      )
    : result;
  return filtered.slice(0, filter.limit);
}
