/**
 * Error factories for the image servers. Each one carries an actionable hint,
 * because the caller is usually an agent that can fix the input.
 */

import { DtstError, badInput } from "@dtst/internal";
import type { BackendKind } from "./backends/types";

export const imgErrors = {
  missingPrompt: (): DtstError =>
    badInput("`prompt` must not be empty.", 'Describe the image, e.g. "a red panda astronaut, studio light".'),

  missingModel: (): DtstError =>
    new DtstError("CONFIG_MISSING", "No image model selected.", {
      hint: "Pass `model`, or set OPENAI_IMAGE_MODEL (e.g. meta/muse-image, google/gemini-3.1-flash-image, gpt-image-1).",
    }),

  needsInputImages: (): DtstError =>
    badInput("`images` must contain at least one image.", "Pass file paths, http(s) URLs, data URLs or raw base64."),

  emptyResponse: (): DtstError =>
    new DtstError("PROVIDER_ERROR", "The provider returned no images.", {
      hint: "Retry once, and check that the model actually produces images (see `list_image_models`).",
    }),

  maskUnsupported: (backend: BackendKind): DtstError =>
    new DtstError("BAD_INPUT", `The ${backend} backend does not support masks.`, {
      hint: "Describe the region to change in `prompt` instead, or use an OpenAI-compatible images/edit endpoint.",
    }),

  editUnsupported: (backend: BackendKind): DtstError =>
    new DtstError("PROVIDER_UNSUPPORTED", `The ${backend} backend cannot edit images.`, {
      hint: "Use a model that accepts image input (e.g. an image-to-image model), or switch backend with DTST_IMG_BACKEND.",
    }),

  batchNotSupported: (backend: BackendKind, max: number): DtstError =>
    badInput(`The ${backend} backend supports at most ${max} image(s) per call.`, "Lower `n`, or repeat the call."),
};

/** Back-compat alias used by the backends. */
export const ERROR_UNSUPPORTED = imgErrors;
