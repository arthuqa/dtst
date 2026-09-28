import { z } from "zod";
import { type ServerLike, defineTool, ok } from "@dtst/internal";
import { runGenerate } from "../operations";
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

export const generateImageSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("What to draw. Be specific about subject, composition, lighting and medium. Up to 30,000 characters."),
  model: modelField,
  n: nField,
  size: sizeField,
  aspect_ratio: aspectRatioField,
  quality: qualityField,
  output_format: outputFormatField,
  background: backgroundField,
  output_compression: outputCompressionField,
  seed: seedField,
  style: styleField,
  negative_prompt: negativePromptField,
  ...outputFields,
});

export type GenerateImageInput = z.infer<typeof generateImageSchema>;

export function registerGenerateImageTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "generate_image",
      title: "Generate image",
      description: [
        "Create one or more images from a text prompt and save them to disk.",
        "Uses the configured OpenAI-compatible endpoint (OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL).",
        "Returns each image inline when small enough, a resource link for every saved file, and absolute paths in structured content.",
        "Use `output_path`/`output_dir`/`filename` when the file must land in a specific place; otherwise images are written to the workspace root.",
      ].join(" "),
      inputSchema: generateImageSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, context) => {
      const outcome = await runGenerate({ ...input, n: input.n ?? 1 }, runtime.operationContext(context));
      context.log.debug("generate_image finished", { images: outcome.images.length, backend: outcome.backend });
      return ok(outcome.content, outcome.structured);
    },
  );
}
