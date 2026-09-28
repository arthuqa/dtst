/**
 * Which model generates images.
 *
 * One knob: `OPENAI_MODEL`, the same variable @dtst/txt uses. A tool call (or
 * the CLI `--model` flag) can always name a different model for a single
 * request; when servers need different models permanently, each gets its own
 * `env` block in the MCP client's config.
 *
 *   "img": { "env": { "OPENAI_MODEL": "meta/muse-image" } }
 *   "txt": { "env": { "OPENAI_MODEL": "openai/gpt-6-luna" } }
 */

import type { ProviderConfig } from "@dtst/internal";
import { imgErrors } from "./errors";

export function resolveImageModel(config: ProviderConfig, requested?: string | undefined): string {
  const model = requested?.trim() || config.textModel?.trim();
  if (!model) throw imgErrors.missingModel();
  return model;
}

/** Label for diagnostics: the model a call will use when none is given. */
export function describeDefaultModel(config: ProviderConfig): string {
  const model = config.textModel?.trim();
  return model ? `${model} (OPENAI_MODEL)` : "(no model configured; set OPENAI_MODEL)";
}
