import { z } from "zod";
import { type ServerLike, defineTool, ok, text } from "@dtst/internal";
import { runChat, textOutcomeSummary } from "../operations";
import type { ToolRuntime } from "../runtime";
import { samplingFields, saveFields } from "./schema";

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]).describe("Who produced this turn."),
        content: z.string().describe("Turn text. Assistant turns are prior replies you are continuing from."),
      }),
    )
    .min(1)
    .describe("The conversation so far, oldest first. The last user message is the one being answered."),
  images: z
    .array(z.string())
    .max(16)
    .optional()
    .describe("Images attached to the last user message (paths, globs, URLs, data URLs, base64 or artifact URIs)."),
  ...samplingFields,
  ...saveFields,
});

export type ChatToolInput = z.infer<typeof chatSchema>;

export function registerChatTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "chat",
      title: "Chat completion",
      description: [
        "Continue a multi-turn conversation with the configured model, optionally with images on the last user turn.",
        "Stateless: pass the full message history each time. Use write_text for one-shot drafting tasks with context files.",
        "The reply is returned inline and can be saved by passing output_path/output_dir/filename.",
      ].join(" "),
      inputSchema: chatSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, context) => {
      const outcome = await runChat(input, runtime.operationContext(context));
      context.log.debug("chat finished", { chars: outcome.text.length, model: outcome.model });
      return ok([...outcome.content, text(textOutcomeSummary(outcome))], outcome.structured);
    },
  );
}
