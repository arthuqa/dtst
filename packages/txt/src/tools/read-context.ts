import path from "node:path";
import { z } from "zod";
import {
  type ContentBlock,
  type ServerLike,
  defineTool,
  formatBytes,
  gatherContext,
  imageContent,
  jsonText,
  ok,
  text,
} from "@dtst/internal";
import type { ToolRuntime } from "../runtime";

export const readContextSchema = z.object({
  files: z.array(z.string()).optional().describe("File paths, globs, file:// URIs or dtst://artifact URIs to read."),
  dirs: z.array(z.string()).optional().describe("Directories to read (non-recursive, capped at 64 files)."),
  urls: z.array(z.string()).optional().describe("http(s) URLs returning text, JSON or images."),
  text: z.array(z.string()).optional().describe("Inline snippets to pass through as context."),
  images: z
    .array(z.string())
    .max(16)
    .optional()
    .describe("Explicit image sources (paths/globs/URLs) to load and return as image content."),
  max_bytes_per_source: z
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .optional()
    .describe("Per-source byte budget (default 262144). Longer files are truncated with a marker."),
  include_content: z
    .boolean()
    .optional()
    .describe("Return the file text in the response (default true). Set false to only get sizes and paths."),
});

export type ReadContextInput = z.infer<typeof readContextSchema>;

/**
 * Read files, directories, URLs, inline snippets and earlier artifacts, and
 * hand them back as prompt-ready text plus image content blocks. Everything
 * read is also registered as an artifact so later calls can reference it by
 * `dtst://artifact/<id>` instead of re-reading the file.
 */
export function registerReadContextTool(server: ServerLike, runtime: ToolRuntime): void {
  defineTool(
    server,
    {
      name: "read_context",
      title: "Read context",
      description: [
        "Pull reference material into the conversation: files, globs, directories, URLs, inline snippets, images, or artifacts from earlier calls.",
        "Returns fenced text blocks (explicitly marked as untrusted data), image content for vision models, and a summary of anything skipped.",
        "Use it to inspect a repo or document set before writing, or to bring an image into the conversation.",
        "Reads are budgeted per source and in total; widen `max_bytes_per_source` for large documents.",
      ].join(" "),
      inputSchema: readContextSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input, context) => {
      const config = runtime.config();
      const requestedImages = input.images ?? [];
      const result = await gatherContext(
        {
          ...(input.files ? { files: input.files } : {}),
          ...(input.dirs ? { dirs: input.dirs } : {}),
          ...(input.urls ? { urls: input.urls } : {}),
          ...(input.text ? { text: input.text } : {}),
          ...(requestedImages.length > 0 ? { files: requestedImages } : {}),
        },
        {
          root: config.workspaceRoot,
          signal: context.signal,
          artifacts: runtime.artifacts,
          maxPerSourceBytes: input.max_bytes_per_source,
        },
      );

      const blocks: ContentBlock[] = [];
      const includeContent = input.include_content !== false;

      for (const chunk of result.chunks) {
        const isImageNote = chunk.text.startsWith("[image:");
        if (isImageNote) {
          blocks.push(text(chunk.text));
          continue;
        }
        // Only real files on disk can be served back over MCP resources;
        // URLs and inline snippets have no path to read later.
        if (path.isAbsolute(chunk.source)) {
          runtime.artifacts.save({
            path: chunk.source,
            kind: "text",
            bytes: chunk.bytes,
            mimeType: "text/plain",
            label: chunk.label,
          });
        }
        blocks.push(
          text(
            includeContent
              ? `--- BEGIN ${chunk.label} (${chunk.source})${chunk.truncated ? " [truncated]" : ""} ---\n${chunk.text}\n--- END ${chunk.label} ---`
              : `${chunk.label} (${chunk.source}) — ${formatBytes(chunk.bytes)}${chunk.truncated ? ", truncated" : ""}`,
          ),
        );
      }

      for (const image of result.images) {
        blocks.push(imageContent(image));
        if (image.path) {
          runtime.artifacts.save({
            path: image.path,
            kind: "image",
            bytes: image.bytes,
            mimeType: image.mimeType,
            label: image.label ?? image.path,
          });
        }
      }

      const summary = [
        `chunks: ${result.chunks.length} (${formatBytes(result.totalBytes)})`,
        `images: ${result.images.length}`,
        ...(result.skipped.length > 0
          ? [`skipped: ${result.skipped.length}`, ...result.skipped.slice(0, 20).map((entry) => `  - ${entry.source}: ${entry.reason}`)]
          : []),
      ].join("\n");
      blocks.push(text(summary));

      return ok(blocks, {
        chunks: result.chunks.map((chunk) => ({
          source: chunk.source,
          label: chunk.label,
          bytes: chunk.bytes,
          truncated: chunk.truncated,
        })),
        images: result.images.map((image) => ({
          source: image.source,
          ...(image.path === undefined ? {} : { path: image.path }),
          mimeType: image.mimeType,
          bytes: image.bytes,
          ...(image.width === undefined ? {} : { width: image.width }),
          ...(image.height === undefined ? {} : { height: image.height }),
        })),
        skipped: result.skipped,
        totalBytes: result.totalBytes,
        truncated: result.truncated,
      });
    },
  );
}

export function contextJson(blocks: unknown): string {
  return jsonText(blocks);
}
