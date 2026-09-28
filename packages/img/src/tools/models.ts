import { z } from "zod";
import { type ServerLike, defineTool, jsonText, ok, text } from "@dtst/internal";
import { listImageModels } from "../backends/select";
import type { ToolRuntime } from "../runtime";
import { clampLimit } from "./schema";
import { describeDefaultModel } from "../model";

export const listImageModelsSchema = z.object({
  query: z.string().optional().describe("Case-insensitive substring filter over model id, name and description."),
  limit: z.number().int().min(1).max(500).optional().describe("Maximum number of models to return (default 50)."),
  output_modalities: z
    .enum(["image", "any"])
    .optional()
    .describe('"image" (default) returns models that emit images; "any" includes text models, which is useful when a chat-completions model produces images.'),
});

export type ListImageModelsInput = z.infer<typeof listImageModelsSchema>;

export function registerListImageModelsTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "list_image_models",
      title: "List image models",
      description: [
        "Discover which image models the configured endpoint offers and how they are reached.",
        "Call this before generating when unsure about a model id, or when a generation failed with a model/endpoint error.",
        "Results include the backend that will be used (images, openrouter, chat).",
      ].join(" "),
      inputSchema: listImageModelsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, context) => {
      const config = runtime.config();
      const limit = clampLimit(input.limit, 50);
      const result = await listImageModels(config, { query: input.query, limit }, {
        log: context.log,
        signal: context.signal,
        progress: context.progress,
      });
      const models = input.output_modalities === "any" ? result.models : result.models.filter((model) => model.outputModalities?.includes("image") ?? true);
      const lines = models.map((model) => {
        const modalities = model.outputModalities?.length ? ` [${model.outputModalities.join("+")}]` : "";
        const providers =
          model.endpointCount === undefined
            ? ""
            : model.endpointCount > 0
              ? ` (${model.endpointCount} provider(s) listed)`
              : " (no providers listed; may still work)";
        return `${model.id}${modalities}${providers}`;
      });
      return ok(
        [
          text(
            [
              `backend: ${result.backend}`,
              ...(result.note ? [`note: ${result.note}`] : []),
              `models: ${models.length}${input.query ? ` matching "${input.query}"` : ""}`,
              ...lines,
              "",
              `Default image model: ${describeDefaultModel(config)}`,
            ].join("\n"),
          ),
        ],
        { backend: result.backend, models, ...(result.note === undefined ? {} : { note: result.note }) },
      );
    },
  );
}

export function renderModelsJson(models: unknown): string {
  return jsonText(models);
}
