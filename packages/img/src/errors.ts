/**
 * Error factories for the image servers. Each one carries an actionable hint,
 * because the caller is usually an agent that can fix the input.
 */

import { DtstError, badInput, toDtstError } from "@dtst/internal";
import type { BackendKind } from "./backends/types";

export const imgErrors = {
  missingPrompt: (): DtstError =>
    badInput("`prompt` must not be empty.", 'Describe the image, e.g. "a red panda astronaut, studio light".'),

  missingModel: (): DtstError =>
    new DtstError("CONFIG_MISSING", "No image model configured.", {
      hint: "Set OPENAI_MODEL in the server's environment (or a .env file), e.g. OPENAI_MODEL=meta/muse-image, google/gemini-3.1-flash-image or gpt-image-1. You can also pass `model` per call.",
    }),

  needsInputImages: (): DtstError =>
    badInput("`images` must contain at least one image.", "Pass file paths, http(s) URLs, data URLs or raw base64."),

  emptyResponse: (): DtstError =>
    new DtstError("PROVIDER_ERROR", "The provider returned no images.", {
      hint: "Retry once, and check that the model actually produces images (see `list_image_models`).",
    }),

  textInsteadOfImage: (model: string, providerMessage?: string): DtstError =>
    new DtstError(
      "PROVIDER_ERROR",
      `The model "${model}" returned text instead of an image.${providerMessage ? ` Provider said: ${providerMessage}` : ""}`,
      {
        hint: `OPENAI_MODEL=${model} does not produce images. Point this server at an image model (e.g. "OPENAI_MODEL": "meta/muse-image" in its env block) or pass an image \`model\` explicitly — see \`list_image_models\`.`,
      },
    ),

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

/**
 * When a generation fails because the model cannot produce images, the
 * provider's own message rarely says so plainly. This rewrites the hint —
 * and only the hint — for model/endpoint-shaped failures, leaving auth,
 * rate-limit, timeout and network errors untouched.
 */
export function withImageModelHint(error: unknown, model: string | undefined): DtstError {
  const dtst = toDtstError(error);
  const modelShaped =
    dtst.code === "PROVIDER_UNSUPPORTED" ||
    /output modalities|no model found|not a valid model|unsupported model|does not support (the )?(requested )?(output|modality|image)/i.test(
      dtst.message,
    );
  if (
    !modelShaped ||
    ["PROVIDER_AUTH", "PROVIDER_RATE_LIMIT", "PROVIDER_TIMEOUT", "NETWORK", "CANCELLED"].includes(dtst.code)
  ) {
    return dtst;
  }
  const label = model?.trim() ? `"${model.trim()}"` : "the configured model";
  return new DtstError(dtst.code, dtst.message, {
    ...(dtst.status === undefined ? {} : { status: dtst.status }),
    retryable: dtst.retryable,
    ...(dtst.details === undefined ? {} : { details: dtst.details }),
    cause: dtst.cause,
    hint: `This server generates images with OPENAI_MODEL, currently ${label}. If that is a chat model, set OPENAI_MODEL to an image model in this server's env block (see \`list_image_models\`) or pass an image \`model\` on the call.`,
  });
}

/** Back-compat alias used by the backends. */
export const ERROR_UNSUPPORTED = imgErrors;
