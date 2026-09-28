/**
 * Shared operations for @dtst/txt: run a completion, optionally attach
 * context and images, optionally persist the result, and shape the MCP reply.
 */

import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtifactStore,
  type ContextRequest,
  type ContextResult,
  type ImageInputObject,
  type Logger,
  type ProgressReporter,
  type ProviderConfig,
  artifactBlocks,
  badInput,
  createOpenAIClient,
  gatherContext,
  loadImages,
  pathOptions,
  resolveOutputFile,
  saveFile,
  text,
} from "@dtst/internal";
import {
  type ChatMessage,
  type CompletionClient,
  type CompletionResult,
  type Usage,
  createCompletionClient,
} from "./api/completions";
import {
  buildSystemPrompt,
  buildUserPrompt,
  extensionForFormat,
  slugify,
  type OutputFormat,
  type Verbosity,
} from "./prompt";

export interface OperationContext {
  config: ProviderConfig;
  log: Logger;
  progress: ProgressReporter;
  signal: AbortSignal;
  artifacts: ArtifactStore;
}

export interface SaveOptions {
  output_path?: string | undefined;
  output_dir?: string | undefined;
  filename?: string | undefined;
  overwrite?: boolean | undefined;
  save?: boolean | undefined;
}

export interface SamplingOptions {
  model?: string | undefined;
  system?: string | undefined;
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  stop?: string[] | undefined;
  reasoning_effort?: string | undefined;
  format?: OutputFormat | undefined;
  verbosity?: Verbosity | undefined;
  stream?: boolean | undefined;
}

export interface WriteTextInput extends SamplingOptions, SaveOptions {
  instructions: string;
  input?: string | undefined;
  context?: ContextRequest | undefined;
  images?: readonly (string | ImageInputObject)[] | undefined;
}

export interface ChatInput extends SamplingOptions, SaveOptions {
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  images?: readonly (string | ImageInputObject)[] | undefined;
}

export interface TextOutcome {
  text: string;
  model: string;
  api: "chat" | "responses";
  usage?: Usage;
  finishReason?: string;
  reasoning?: string;
  saved?: { path: string; bytes: number; artifactUri?: string };
  content: ContentBlock[];
  structured: Record<string, unknown>;
  summary: string;
  notes: string[];
  contextSummary?: { chunks: number; images: number; skipped: number; bytes: number; details: string[] };
  durationMs: number;
}

export function completionClientFor(config: ProviderConfig): CompletionClient {
  return createCompletionClient(config, createOpenAIClient(config));
}

export async function runWriteText(input: WriteTextInput, context: OperationContext): Promise<TextOutcome> {
  const model = resolveModel(input, context);
  const started = Date.now();

  const gathered = await collectContext(input.context, context);
  const { images, skipped } = await loadImages(input.images ?? [], {
    root: context.config.workspaceRoot,
    maxBytes: context.config.maxImageBytes,
    maxCount: context.config.maxImages,
    signal: context.signal,
    artifacts: context.artifacts,
  });
  if (skipped.length > 0) context.log.debug("skipped input images", { skipped });

  const system = buildSystemPrompt({
    system: input.system,
    verbosity: input.verbosity,
    format: input.format,
    toolName: "write_text",
  });
  const user = buildUserPrompt({
    instructions: input.instructions,
    input: input.input,
    context: gathered,
    images: images.map((image) => ({
      label: image.label ?? image.source,
      mimeType: image.mimeType,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    })),
  });

  const messages: ChatMessage[] = [
    { role: "system", text: system },
    { role: "user", text: user, ...(images.length > 0 ? { images } : {}) },
  ];

  const result = await execute(messages, input, model, context);
  const outcome = await persistAndDescribe(result, input, context, started, {
    chunks: gathered.chunks.length,
    images: images.length,
    skipped: skipped.length,
    bytes: gathered.totalBytes,
    details: describeContext(gathered),
  });
  return appendSkippedImages(outcome, skipped);
}

/** Surface dropped image inputs instead of silently ignoring them. */
function appendSkippedImages(
  outcome: TextOutcome,
  skipped: readonly { source: string; reason: string }[],
): TextOutcome {
  if (skipped.length === 0) return outcome;
  const summary = skipped.map((entry) => `${entry.source} (${entry.reason})`).join("; ");
  outcome.content.push(text(`Skipped ${skipped.length} image(s): ${summary}`));
  outcome.structured["skippedImages"] = skipped;
  outcome.notes.push(...skipped.map((entry) => `skipped image ${entry.source}: ${entry.reason}`));
  return outcome;
}

export async function runChat(input: ChatInput, context: OperationContext): Promise<TextOutcome> {
  const model = resolveModel(input, context);
  const started = Date.now();
  if (input.messages.length === 0) {
    throw badInput("`messages` must contain at least one entry.", "Pass the conversation so far, oldest first.");
  }

  const { images, skipped } = await loadImages(input.images ?? [], {
    root: context.config.workspaceRoot,
    maxBytes: context.config.maxImageBytes,
    maxCount: context.config.maxImages,
    signal: context.signal,
    artifacts: context.artifacts,
  });

  const system = buildSystemPrompt({
    system: input.system,
    verbosity: input.verbosity,
    format: input.format,
    toolName: "chat",
  });
  const messages: ChatMessage[] = [{ role: "system", text: system }];
  const lastUserIndex = findLastUserIndex(input.messages);
  for (const [index, message] of input.messages.entries()) {
    const attachImages = images.length > 0 && index === lastUserIndex;
    messages.push({
      role: message.role,
      text: message.content,
      ...(attachImages ? { images } : {}),
    });
  }

  const result = await execute(messages, input, model, context);
  const outcome = await persistAndDescribe(
    result,
    { ...input, save: input.save ?? hasExplicitDestination(input) },
    context,
    started,
  );
  return appendSkippedImages(outcome, skipped);
}

function findLastUserIndex(messages: readonly { role: string }[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

async function execute(
  messages: ChatMessage[],
  input: SamplingOptions,
  model: string,
  context: OperationContext,
): Promise<CompletionResult & { api: "chat" | "responses"; client: CompletionClient }> {
  const client = completionClientFor(context.config);
  await context.progress.report(0, undefined, `asking ${model} via ${client.api} API`);

  const request = {
    model,
    messages,
    ...(input.max_tokens === undefined ? {} : { maxTokens: input.max_tokens }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { topP: input.top_p }),
    ...(input.stop === undefined ? {} : { stop: input.stop }),
    ...(input.reasoning_effort === undefined ? {} : { reasoningEffort: input.reasoning_effort }),
    jsonMode: input.format === "json",
  };

  const result = await client.complete(request, {
    config: context.config,
    log: context.log,
    progress: context.progress,
    signal: context.signal,
    stream: input.stream === true,
  });

  await context.progress.report(1, 1, "done");
  return { ...result, api: client.api, client };
}

async function persistAndDescribe(
  result: CompletionResult & { api: "chat" | "responses" },
  input: SaveOptions & SamplingOptions & { instructions?: string; messages?: readonly { content: string }[] },
  context: OperationContext,
  started: number,
  contextSummary?: TextOutcome["contextSummary"],
): Promise<TextOutcome> {
  const derivedName = input.instructions ? slugify(input.instructions, "text") : undefined;
  const fallbackName = derivedName ?? "text";
  const extension = extensionForFormat(input.format);
  const shouldSave = input.save === true || (input.save !== false && hasExplicitDestination(input));

  const content: ContentBlock[] = [];
  const notes: string[] = [];
  let saved: TextOutcome["saved"];
  let summary = result.text;

  if (shouldSave) {
    const pathOpts = pathOptions(context.config);
    const target = await resolveOutputFile(
      {
        outputPath: input.output_path,
        outputDir: input.output_dir,
        filename: input.filename,
        defaultFilename: fallbackName,
        extension,
      },
      pathOpts,
    );
    const written = await saveFile(target, result.text, {
      policy: input.overwrite === true ? "overwrite" : "suffix",
      options: pathOpts,
    });
    const blocks = artifactBlocks({
      store: context.artifacts,
      path: written.path,
      kind: "text",
      bytes: written.bytes,
      mimeType: mimeForFormat(input.format),
      label: written.path.split("/").pop() ?? written.path,
      content: result.text,
      inline: result.text,
      inlineMimeType: mimeForFormat(input.format),
      root: context.config.workspaceRoot,
    });
    content.push(...blocks);
    const artifactBlock = blocks.find((block) => block.type === "text" && block.text.includes("Artifact:"));
    const artifactUri =
      artifactBlock && artifactBlock.type === "text" ? /Artifact: (\S+)/.exec(artifactBlock.text)?.[1] : undefined;
    saved = { path: written.path, bytes: written.bytes, ...(artifactUri === undefined ? {} : { artifactUri }) };
    summary = `Wrote ${written.bytes} bytes to ${written.path}`;
  }

  content.push(text(result.text));

  const durationMs = Date.now() - started;
  const structured: Record<string, unknown> = {
    text: result.text,
    model: result.model,
    api: result.api,
    chars: result.text.length,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(saved === undefined ? {} : { saved }),
    ...(contextSummary === undefined ? {} : { context: contextSummary }),
    durationMs,
  };

  return {
    text: result.text,
    model: result.model,
    api: result.api,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
    ...(saved === undefined ? {} : { saved }),
    content,
    structured,
    summary,
    notes,
    ...(contextSummary === undefined ? {} : { contextSummary }),
    durationMs,
  };
}

function hasExplicitDestination(input: SaveOptions): boolean {
  return Boolean(input.output_path?.trim() || input.output_dir?.trim() || input.filename?.trim());
}

function resolveModel(input: SamplingOptions, context: OperationContext): string {
  const model = input.model ?? context.config.textModel;
  if (!model) {
    throw new Error(
      "No text model configured: pass `model` or set OPENAI_MODEL. Example: OPENAI_MODEL=openai/gpt-6-luna",
    );
  }
  return model;
}

async function collectContext(request: ContextRequest | undefined, context: OperationContext): Promise<ContextResult> {
  if (!request || isEmptyRequest(request)) {
    return { chunks: [], images: [], skipped: [], totalBytes: 0, truncated: false };
  }
  return gatherContext(request, {
    root: context.config.workspaceRoot,
    signal: context.signal,
    artifacts: context.artifacts,
  });
}

function isEmptyRequest(request: ContextRequest): boolean {
  return (
    (request.files?.length ?? 0) === 0 &&
    (request.dirs?.length ?? 0) === 0 &&
    (request.urls?.length ?? 0) === 0 &&
    (request.text?.length ?? 0) === 0 &&
    (request.artifacts?.length ?? 0) === 0
  );
}

function describeContext(result: ContextResult): string[] {
  return [
    ...result.chunks.map((chunk) => `${chunk.label} (${chunk.bytes} bytes${chunk.truncated ? ", truncated" : ""})`),
    ...result.skipped.map((entry) => `${entry.source}: ${entry.reason}`),
  ];
}

export function mimeForFormat(format: OutputFormat | undefined): string {
  if (format === "json") return "application/json";
  return "text/markdown";
}

export function textOutcomeSummary(outcome: TextOutcome): string {
  const lines = [`${outcome.text.length} chars from ${outcome.model} (${outcome.api} API)`];
  if (outcome.usage) {
    const parts: string[] = [];
    if (outcome.usage.inputTokens !== undefined) parts.push(`in ${outcome.usage.inputTokens}`);
    if (outcome.usage.outputTokens !== undefined) parts.push(`out ${outcome.usage.outputTokens}`);
    if (outcome.usage.totalTokens !== undefined) parts.push(`total ${outcome.usage.totalTokens}`);
    if (outcome.usage.costUsd !== undefined) parts.push(`cost $${outcome.usage.costUsd.toFixed(6)}`);
    if (parts.length > 0) lines.push(`usage: ${parts.join(", ")}`);
  }
  if (outcome.saved) lines.push(`saved: ${outcome.saved.path}`);
  return lines.join("\n");
}
