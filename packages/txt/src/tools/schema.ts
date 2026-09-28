import { z } from "zod";

export const modelField = z
  .string()
  .min(1)
  .optional()
  .describe("Model id. Defaults to OPENAI_MODEL. Examples: openai/gpt-6-luna, anthropic/claude-opus-5.5, qwen/qwen3.8-max.");

export const samplingFields = {
  model: modelField,
  system: z
    .string()
    .optional()
    .describe("Extra system-level guidance appended to the built-in system prompt (persona, audience, constraints)."),
  max_tokens: z.number().int().min(1).max(200_000).optional().describe("Upper bound on generated tokens."),
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature (0 = deterministic)."),
  top_p: z.number().min(0).max(1).optional().describe("Nucleus sampling probability mass."),
  stop: z.array(z.string()).max(4).optional().describe("Stop sequences."),
  reasoning_effort: z
    .string()
    .optional()
    .describe('Reasoning budget for models that support it: "low", "medium" or "high" (provider-specific).'),
  format: z
    .enum(["text", "markdown", "json"])
    .optional()
    .describe('Desired output shape. "json" switches on JSON mode and validates nothing else — check the result.'),
  verbosity: z.enum(["concise", "balanced", "detailed"]).optional().describe("How much detail to produce. Defaults to balanced."),
  stream: z
    .boolean()
    .optional()
    .describe("Stream tokens from the provider and report progress (default false, which is more compatible)."),
} as const;

export const saveFields = {
  output_path: z
    .string()
    .optional()
    .describe("Exact file (or directory) to write the result to; relative paths resolve against the workspace root."),
  output_dir: z.string().optional().describe("Directory to write into. Ignored when output_path is set."),
  filename: z.string().optional().describe("Preferred file name (an extension is added for the chosen `format`)."),
  overwrite: z.boolean().optional().describe("Replace an existing file instead of adding a -1 suffix. Defaults to false."),
  save: z
    .boolean()
    .optional()
    .describe("Force writing to disk. Defaults to false, except when output_path/output_dir/filename is provided."),
} as const;
