/**
 * Which model generates images.
 *
 * Resolution order, most specific first:
 *   1. `model` on the tool call / CLI flag
 *   2. `DTST_IMAGE_MODEL` — optional override for endpoints where the text and
 *      image models differ (they always do on OpenRouter, for example)
 *   3. `OPENAI_MODEL` — the single model knob shared with @dtst/txt
 *
 * Keeping `OPENAI_MODEL` as the final fallback means the documented trio
 * (OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL) is sufficient on its own.
 */

import type { ProviderConfig } from "@dtst/internal";
import { imgErrors } from "./errors";

export function resolveImageModel(config: ProviderConfig, requested?: string | undefined): string {
  const model = requested?.trim() || config.imageModel?.trim() || config.textModel?.trim();
  if (!model) throw imgErrors.missingModel();
  return model;
}

/** Label for diagnostics: what a call will use when `model` is omitted. */
export function describeDefaultModel(config: ProviderConfig): string {
  const model = config.imageModel?.trim() || config.textModel?.trim();
  if (!model) return "(no model configured; set OPENAI_MODEL)";
  return config.imageModel ? `${model} (DTST_IMAGE_MODEL)` : `${model} (OPENAI_MODEL)`;
}
