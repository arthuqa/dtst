import { z } from "zod";
import { type ServerLike, defineTool, ok, text } from "@dtst/internal";
import { runWriteText, textOutcomeSummary } from "../operations";
import type { ToolRuntime } from "../runtime";
import { samplingFields, saveFields } from "./schema";

export const writeTextSchema = z.object({
  instructions: z
    .string()
    .min(1)
    .describe(
      'The writing task, e.g. "Summarise these release notes as 5 bullets for a non-technical reader" or "Draft a reply to this email".',
    ),
  input: z
    .string()
    .optional()
    .describe("Inline source material to rewrite, translate, summarise or fix. Alternative to `context` for short texts."),
  context: z
    .object({
      files: z.array(z.string()).optional().describe("File paths, globs, file:// URIs or artifact URIs."),
      dirs: z.array(z.string()).optional().describe("Directories to include (non-recursive, capped)."),
      urls: z.array(z.string()).optional().describe("http(s) URLs returning text, JSON or images."),
      text: z.array(z.string()).optional().describe("Inline snippets to treat as context."),
      artifacts: z.array(z.string()).optional().describe("dtst://artifact/<id> references from earlier tool calls."),
    })
    .optional()
    .describe("Untrusted reference material pulled in from the workspace, the web, or earlier results."),
  images: z
    .array(z.string())
    .max(16)
    .optional()
    .describe(
      "Images to attach to the request for vision models: file paths, globs, http(s) URLs, data URLs, base64 or artifact URIs.",
    ),
  ...samplingFields,
  ...saveFields,
});

export type WriteTextInput = z.infer<typeof writeTextSchema>;

export function registerWriteTextTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "write_text",
      title: "Write text",
      description: [
        "Produce text with the configured model: drafting, summarising, rewriting, translating, extracting structured data.",
        "Accepts untrusted reference material through `context` (files, globs, directories, URLs, earlier artifacts) and multiple images for vision models.",
        "The result is returned inline; it is written to disk when `output_path`, `output_dir` or `filename` is given (or `save: true`).",
        "Use this instead of improvising prose when the answer must be grounded in material from the workspace.",
      ].join(" "),
      inputSchema: writeTextSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, context) => {
      const outcome = await runWriteText(input, runtime.operationContext(context));
      context.log.debug("write_text finished", { chars: outcome.text.length, model: outcome.model });
      return ok([
        ...outcome.content,
        text(textOutcomeSummary(outcome)),
      ], outcome.structured);
    },
  );
}
