/**
 * MCP result + tool wiring helpers shared by both servers.
 *
 * Design rules encoded here:
 *  - Tool failures are returned as `isError: true` with a stable `code`,
 *    a human message and an actionable `hint` (never a thrown exception).
 *  - Anything written to disk is reported three ways: a `resource_link`
 *    (cheap, clients can read it back), an optional embedded `resource`
 *    (inline bytes for clients without resource support), and a text summary
 *    carrying the absolute path.
 *  - Secrets are scrubbed by the logger and by `fail()`.
 */

import type { CallToolResult, ContentBlock, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ArtifactStore, type ArtifactKind } from "./artifacts";
import { toDtstError } from "./errors";
import { type LoadedImage } from "./images";
import { type Logger, createLogger, redact } from "./log";
import { fileUri, relativeForDisplay } from "./paths";
import { type ProgressReporter, abortSignal, createProgress } from "./progress";

export const MAX_INLINE_RESOURCE_BYTES = 4 * 1024 * 1024;

export function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function imageContent(image: LoadedImage): ContentBlock {
  return { type: "image", data: image.base64, mimeType: image.mimeType };
}

export function imageBlockFrom(data: Uint8Array, mimeType: string): ContentBlock {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
}

export interface ResourceLinkOptions {
  name?: string;
  mimeType?: string;
  size?: number;
  description?: string;
}

export function resourceLink(file: string, options: ResourceLinkOptions = {}): ContentBlock {
  const link = {
    type: "resource_link" as const,
    uri: fileUri(file),
    name: options.name ?? file.split("/").pop() ?? file,
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
  return link as ContentBlock;
}

export function embeddedTextResource(file: string, content: string, mimeType = "text/plain"): ContentBlock {
  return {
    type: "resource",
    resource: { uri: fileUri(file), mimeType, text: content },
  } as ContentBlock;
}

export function embeddedBlobResource(file: string, data: Uint8Array, mimeType: string): ContentBlock {
  return {
    type: "resource",
    resource: { uri: fileUri(file), mimeType, blob: Buffer.from(data).toString("base64") },
  } as ContentBlock;
}

export interface ArtifactBlocksInput {
  store: ArtifactStore;
  path: string;
  kind: ArtifactKind;
  bytes: number;
  mimeType?: string;
  label?: string;
  /** Text content for `kind: "text"`, used for inline reads. */
  content?: string;
  /** Inline the bytes as an embedded resource (images and small files). */
  inline?: Uint8Array | string;
  inlineMimeType?: string;
  /** Extra summary line appended to the text block. */
  summary?: string;
  root?: string;
}

/** Canonical "file was written" output: artifact link + summary (+ inline bytes). */
export function artifactBlocks(input: ArtifactBlocksInput): ContentBlock[] {
  const artifact = input.store.save({
    path: input.path,
    kind: input.kind,
    bytes: input.bytes,
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.content === undefined ? {} : { text: input.content }),
  });

  const blocks: ContentBlock[] = [
    resourceLink(artifact.path, {
      name: artifact.label ?? artifact.path.split("/").pop() ?? artifact.path,
      ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      size: artifact.bytes,
      description: `Saved by dtst · ${artifact.uri}`,
    }),
  ];

  if (input.inline !== undefined) {
    const data = typeof input.inline === "string" ? Buffer.from(input.inline, "utf8") : input.inline;
    if (data.byteLength <= MAX_INLINE_RESOURCE_BYTES) {
      const mime = input.inlineMimeType ?? input.mimeType ?? "application/octet-stream";
      blocks.push(
        typeof input.inline === "string"
          ? embeddedTextResource(artifact.path, input.inline, mime)
          : embeddedBlobResource(artifact.path, data, mime),
      );
    }
  }

  const relative = relativeForDisplay(artifact.path, input.root ? { root: input.root } : {});
  const lines = [
    `Saved: ${relative === artifact.path ? artifact.path : `${relative} (${artifact.path})`}`,
    `Artifact: ${artifact.uri}`,
    `Bytes: ${artifact.bytes}`,
    ...(artifact.mimeType ? [`Type: ${artifact.mimeType}`] : []),
    ...(input.summary ? [input.summary] : []),
  ];
  blocks.push(text(lines.join("\n")));
  return blocks;
}

export interface ContextImageSummary {
  label: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export function sumImages(images: readonly LoadedImage[]): ContextImageSummary[] {
  return images.map((image) => ({
    label: image.label ?? image.source,
    mimeType: image.mimeType,
    bytes: image.bytes,
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
  }));
}

export type ToolResult = CallToolResult;

export function ok(content: ContentBlock | ContentBlock[], structured?: Record<string, unknown>): ToolResult {
  const blocks = Array.isArray(content) ? content : [content];
  if (blocks.length === 0) blocks.push(text("ok"));
  return structured ? { content: blocks, structuredContent: structured } : { content: blocks };
}

export function fail(error: unknown): ToolResult {
  const dtst = toDtstError(error);
  const message = redact(dtst.format());
  return {
    content: [text(message)],
    structuredContent: {
      error: {
        code: dtst.code,
        message: redact(dtst.message),
        ...(dtst.hint === undefined ? {} : { hint: redact(dtst.hint) }),
        ...(dtst.status === undefined ? {} : { status: dtst.status }),
      },
    },
    isError: true,
  };
}

export interface ToolContext {
  signal: AbortSignal;
  progress: ProgressReporter;
  requestId?: string | number;
  log: Logger;
}

export interface ServerLike {
  registerTool: (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      annotations?: ToolAnnotations;
    },
    handler: (input: never, extra: never) => Promise<CallToolResult> | CallToolResult,
  ) => unknown;
  registerResource?: (
    name: string,
    template: unknown,
    handler: (uri: URL, variables: Record<string, string>, extra: unknown) => unknown,
  ) => unknown;
}

export interface ToolDefinition<Schema extends z.ZodType> {
  name: string;
  title?: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
}

/**
 * Register a tool with uniform logging, cancellation and error handling.
 *
 * The SDK validates `input` against `inputSchema` before the handler runs, so
 * the handler receives a `z.output<Schema>` and may assume it is well-formed.
 */
export function defineTool<Schema extends z.ZodType>(
  server: ServerLike,
  definition: ToolDefinition<Schema>,
  handler: (input: z.output<Schema>, context: ToolContext) => Promise<ToolResult>,
  options: { logger?: Logger } = {},
): void {
  const log = (options.logger ?? createLogger(definition.name)).child(definition.name);
  const config: Parameters<ServerLike["registerTool"]>[1] = {
    description: definition.description,
  };
  if (definition.title !== undefined) config.title = definition.title;
  config.inputSchema = definition.inputSchema;
  if (definition.annotations !== undefined) config.annotations = definition.annotations;

  const wrapped = async (rawInput: unknown, extra: unknown): Promise<CallToolResult> => {
    const started = Date.now();
    const context: ToolContext = {
      signal: abortSignal(extra),
      progress: createProgress(extra),
      requestId: (extra as { requestId?: string | number } | undefined)?.requestId,
      log,
    };
    try {
      const result = await handler(rawInput as z.output<Schema>, context);
      log.debug("tool ok", { ms: Date.now() - started, isError: result.isError === true });
      return result;
    } catch (error) {
      const dtst = toDtstError(error);
      log.warn("tool failed", { code: dtst.code, ms: Date.now() - started, message: dtst.message });
      return fail(dtst);
    }
  };

  server.registerTool(definition.name, config, wrapped as never);
}

/**
 * Expose saved artifacts over MCP resources so a client can re-read a file
 * this server produced (`dtst://artifact/<id>`).
 *
 * Note: the SDK advertises a 3-argument `registerResource(name, uri, cb)`
 * overload but only implements the 4-argument form at runtime, so the config
 * argument is always passed explicitly.
 */
export function registerArtifactResources(
  server: {
    registerResource: (
      name: string,
      template: unknown,
      config: { title?: string; description?: string },
      handler: (uri: URL, variables: Record<string, string>) => unknown,
    ) => unknown;
  },
  store: ArtifactStore,
  ResourceTemplateCtor: new (uri: string, options?: { list?: unknown }) => unknown,
): void {
  const template = new ResourceTemplateCtor("dtst://artifact/{id}", {
    list: async () => ({
      resources: store.list().map((artifact) => ({
        uri: artifact.uri,
        name: artifact.label ?? artifact.path.split("/").pop() ?? artifact.id,
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      })),
    }),
  });

  server.registerResource(
    "artifact",
    template,
    {
      title: "Saved artifact",
      description: "A file written by this server (image, text or downloaded content).",
    },
    async (uri: URL) => {
      const id = uri.href.replace(/^dtst:\/\/artifact\//, "");
      const artifact = store.get(id);
      if (!artifact) {
        throw new Error(`Unknown artifact ${uri.href}`);
      }
      const { readFile } = await import("node:fs/promises");
      const buffer = await readFile(artifact.path);
      const mimeType = artifact.mimeType ?? "application/octet-stream";
      const isText = mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+xml");
      return {
        contents: [
          {
            uri: artifact.uri,
            mimeType,
            ...(isText ? { text: buffer.toString("utf8") } : { blob: buffer.toString("base64") }),
          },
        ],
      };
    },
  );
}

/** Re-exported so packages can build MCP content without importing the SDK. */
export type { CallToolResult, ContentBlock, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
