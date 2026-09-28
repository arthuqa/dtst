import { z } from "zod";
import { type ServerLike, defineTool, ok } from "@dtst/internal";
import { runEdit } from "../operations";
import type { ToolRuntime } from "../runtime";
import {
  aspectRatioField,
  backgroundField,
  modelField,
  nField,
  negativePromptField,
  outputCompressionField,
  outputFields,
  outputFormatField,
  qualityField,
  seedField,
  sizeField,
  styleField,
} from "./schema";

export const editImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("The change to apply, e.g. \"replace the background with a sunset beach\" or \"make it look like a pencil sketch\"."),
  images: z
    .array(z.string())
    .min(1)
    .max(16)
    .describe(
      "Input images. Each entry may be a file path, a glob (assets/*.png), an http(s) URL, a data: URL, raw base64, or an artifact URI returned by an earlier call.",
    ),
  mask: z
    .string()
    .optional()
    .describe(
      "Optional mask image (OpenAI images/edit only): transparent pixels mark the area to regenerate. Rejected by backends without mask support.",
    ),
  model: modelField,
  n: nField,
  size: sizeField,
  aspect_ratio: aspectRatioField,
  quality: qualityField,
  input_fidelity: z
    .enum(["high", "low"])
    .optional()
    .describe("How strongly to preserve the input image's details (OpenAI gpt-image models)."),
  output_format: outputFormatField,
  background: backgroundField,
  output_compression: outputCompressionField,
  seed: seedField,
  style: styleField,
  negative_prompt: negativePromptField,
  ...outputFields,
});

export type EditImageInput = z.infer<typeof editImageSchema>;

export function registerEditImageTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "edit_image",
      title: "Edit image",
      description: [
        "Modify existing image(s) with a text instruction, preserving the parts the instruction does not mention.",
        "Accepts one or more inputs (paths, globs, URLs, data URLs, base64, or artifact URIs from earlier calls).",
        "Saved output follows the same conventions as generate_image: inline preview, resource link, absolute path.",
      ].join(" "),
      inputSchema: editImageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, context) => {
      const outcome = await runEdit({ ...input, n: input.n ?? 1 }, runtime.operationContext(context));
      context.log.debug("edit_image finished", { images: outcome.images.length, backend: outcome.backend });
      return ok(outcome.content, outcome.structured);
    },
  );
}
