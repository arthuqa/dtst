/**
 * `GET /models` for any OpenAI-compatible endpoint. Shared by the
 * `list_models` MCP tool and the `txt models` CLI command.
 */

import { type ProviderConfig, requestJson } from "@dtst/internal";

export interface ModelEntry {
  id: string;
  name?: string;
  contextLength?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  pricing?: Record<string, string>;
}

interface RawModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    context_window?: number;
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    pricing?: Record<string, string>;
  }>;
}

export interface ListModelsResult {
  models: ModelEntry[];
  total: number;
}

export async function listModels(
  config: ProviderConfig,
  filter: { query?: string | undefined; limit: number },
  options: { signal?: AbortSignal } = {},
): Promise<ListModelsResult> {
  const response = await requestJson<RawModelsResponse>(`${config.baseUrl}/models`, {
    ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
    timeoutMs: Math.min(config.timeoutMs, 30_000),
    maxRetries: config.maxRetries,
    ...(options.signal ? { signal: options.signal } : {}),
    label: "GET /models",
    maxBytes: 8 * 1024 * 1024,
  });

  const all: ModelEntry[] = (response.json?.data ?? [])
    .filter((model): model is typeof model & { id: string } => typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.context_length === undefined && model.context_window === undefined
        ? {}
        : { contextLength: model.context_length ?? model.context_window }),
      ...(model.architecture?.input_modalities === undefined ? {} : { inputModalities: model.architecture.input_modalities }),
      ...(model.architecture?.output_modalities === undefined ? {} : { outputModalities: model.architecture.output_modalities }),
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    }));

  const query = filter.query?.trim().toLowerCase();
  const matching = query
    ? all.filter((model) => model.id.toLowerCase().includes(query) || (model.name ?? "").toLowerCase().includes(query))
    : all;
  return { models: matching.slice(0, filter.limit), total: all.length };
}

export function describeModel(model: ModelEntry): string {
  const parts = [model.id];
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  if (model.inputModalities?.includes("image")) parts.push("vision");
  if (model.inputModalities?.includes("file")) parts.push("files");
  return parts.join(" · ");
}
