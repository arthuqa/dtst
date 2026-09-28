/**
 * Shared zod fragments for the image tools.
 *
 * Descriptions matter as much as validation here: the caller is a model, so
 * every field explains the formats it accepts and where output will land.
 */

import { z } from "zod";

export const modelField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Image model id. Defaults to OPENAI_MODEL; pass this to use a different model for one call. Examples: meta/muse-image, google/gemini-3.1-flash-image, openai/gpt-image-1, dall-e-3.",
  );

export const nField = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe("How many images to produce (1-10). Defaults to 1. Some backends generate sequentially.");

export const sizeField = z
  .string()
  .optional()
  .describe(
    'Output size. Either explicit pixels ("1024x1024", "1536x1024", any WIDTHxHEIGHT divisible by 16) or an OpenRouter tier ("1K", "2K", "4K", "auto").',
  );

export const aspectRatioField = z
  .string()
  .optional()
  .describe('Aspect ratio for providers that take one instead of pixel sizes, e.g. "16:9", "1:1", "4:5", "auto".');

export const qualityField = z
  .string()
  .optional()
  .describe('Quality hint: "low", "medium", "high", "xhigh", "max", "auto", or DALL-E\'s "standard"/"hd".');

export const outputFormatField = z
  .enum(["png", "jpeg", "webp"])
  .optional()
  .describe("Encoding of the returned file. Defaults to the provider's preference (usually png).");

export const backgroundField = z
  .enum(["transparent", "opaque", "auto"])
  .optional()
  .describe('Background handling. "transparent" requires png or webp output.');

export const outputCompressionField = z
  .number()
  .int()
  .min(0)
  .max(100)
  .optional()
  .describe("Compression level for jpeg/webp output (0-100).");

export const seedField = z.number().int().optional().describe("Seed for reproducible results, when the provider supports it.");

export const styleField = z
  .string()
  .optional()
  .describe('Free-form style guidance appended to the prompt, e.g. "watercolor, soft light, 35mm".');

export const negativePromptField = z
  .string()
  .optional()
  .describe("Things to avoid, appended to the prompt as an exclusion list.");

export const outputFields = {
  output_path: z
    .string()
    .optional()
    .describe(
      "Exact file (or directory) to write to. Relative paths resolve against the workspace root (DTST_WORKSPACE, else the process cwd). Use this when the surrounding task requires a specific location.",
    ),
  output_dir: z.string().optional().describe("Directory to write into. Ignored when output_path is set."),
  filename: z.string().optional().describe("Preferred file name; an extension is added from the returned image type."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Replace an existing file instead of appending -1, -2, ... to the name. Defaults to false."),
  save: z.boolean().optional().describe("Write the image(s) to disk. Defaults to true; set false for a preview-only call."),
  inline: z
    .boolean()
    .optional()
    .describe("Return the image bytes inline so the caller can see them (default true, capped at 4 images / 8 MiB)."),
} as const;

export const imageEditOutputFields = outputFields;

export function clampLimit(value: number | undefined, fallback: number, max = 500): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}
