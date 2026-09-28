import { z } from "zod";
import { type ServerLike, defineTool, ok, text } from "@dtst/internal";
import { describeModel, listModels } from "../models";
import type { ToolRuntime } from "../runtime";

export const listModelsSchema = z.object({
  query: z.string().optional().describe("Case-insensitive substring filter over model ids and names."),
  limit: z.number().int().min(1).max(1000).optional().describe("Maximum results (default 100)."),
});

export type ListModelsInput = z.infer<typeof listModelsSchema>;

export function registerListModelsTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "list_models",
      title: "List models",
      description: [
        "List the models the configured endpoint exposes, with context length and input/output modalities when the provider reports them.",
        "Use it to pick a model id for `write_text`/`chat`/OPENAI_MODEL, or to confirm a model accepts images before attaching any.",
      ].join(" "),
      inputSchema: listModelsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, context) => {
      const config = runtime.config();
      const { models, total } = await listModels(
        config,
        { query: input.query, limit: input.limit ?? 100 },
        { signal: context.signal },
      );

      const lines = models.map((model) => describeModel(model));
      const vision = models.filter((model) => model.inputModalities?.includes("image")).length;
      return ok(
        [
          text(
            [
              `endpoint: ${config.baseUrl}`,
              `default model: ${config.textModel ?? "(OPENAI_MODEL is not set)"}`,
              `models: ${models.length}${input.query ? ` matching "${input.query}"` : ""} of ${total}${vision > 0 ? ` · ${vision} accept images` : ""}`,
              ...lines,
            ].join("\n"),
          ),
        ],
        {
          total,
          defaultModel: config.textModel ?? null,
          models,
        },
      );
    },
  );
}
