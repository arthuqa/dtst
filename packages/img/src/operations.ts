/**
 * Operations layer: the single implementation of "generate/edit an image,
 * save it where the agent asked, and describe the result".
 *
 * Both the MCP tools and the CLI call these functions, so behaviour (path
 * handling, collision policy, inline payloads, usage reporting) is identical
 * no matter how the server is driven.
 */

import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtifactStore,
  type Logger,
  type ProgressReporter,
  type ProviderConfig,
  artifactBlocks,
  extensionForMime,
  formatBytes,
  imageContent,
  imageDimensions,
  type ImageInputObject,
  loadImages,
  pathOptions,
  resolveOutputFile,
  saveFile,
  suffixPath,
  text,
} from "@dtst/internal";
import { imgErrors } from "./errors";
import { filenameFromPrompt } from "./prompt";
import { resolveBackend } from "./backends/select";
import type { BackendKind, EditRequest, GenerateRequest, RenderedImage, Usage } from "./backends/types";

export interface OperationContext {
  config: ProviderConfig;
  log: Logger;
  progress: ProgressReporter;
  signal: AbortSignal;
  artifacts: ArtifactStore;
}

export interface OutputOptions {
  output_path?: string | undefined;
  output_dir?: string | undefined;
  filename?: string | undefined;
  overwrite?: boolean | undefined;
  /** Write files to disk (default true). */
  save?: boolean | undefined;
  /** Return image bytes inline (default true, budgeted). */
  inline?: boolean | undefined;
}

export interface GenerateOperationInput extends OutputOptions {
  prompt: string;
  model?: string | undefined;
  n: number;
  size?: string | undefined;
  resolution?: string | undefined;
  aspect_ratio?: string | undefined;
  quality?: string | undefined;
  output_format?: "png" | "jpeg" | "webp" | undefined;
  background?: "transparent" | "opaque" | "auto" | undefined;
  output_compression?: number | undefined;
  seed?: number | undefined;
  negative_prompt?: string | undefined;
  style?: string | undefined;
  user?: string | undefined;
}

export interface EditOperationInput extends GenerateOperationInput {
  images: readonly (string | ImageInputObject)[];
  mask?: string | undefined;
  input_fidelity?: "high" | "low" | undefined;
}

export interface SavedImage {
  index: number;
  label: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  path?: string;
  artifactUri?: string;
  fileUri?: string;
  inlined: boolean;
}

export interface OperationOutcome {
  images: SavedImage[];
  model: string;
  backend: BackendKind;
  usage?: Usage;
  notes: string[];
  content: ContentBlock[];
  summary: string;
  structured: Record<string, unknown>;
  durationMs: number;
}

export const MAX_INLINE_IMAGES = 4;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export async function runGenerate(input: GenerateOperationInput, context: OperationContext): Promise<OperationOutcome> {
  const request = toGenerateRequest(input);
  const selection = await resolveBackend(context.config, { model: request.model, log: context.log }, context.signal);
  const started = Date.now();
  const result = await selection.backend.generate(request, context);
  return finalize(result, input, context, selection.backend.kind, Date.now() - started);
}

export async function runEdit(input: EditOperationInput, context: OperationContext): Promise<OperationOutcome> {
  const selection = await resolveBackend(context.config, { model: input.model, log: context.log }, context.signal);
  if (!selection.backend.capabilities.edit || !selection.backend.edit) throw imgErrors.editUnsupported(selection.backend.kind);
  if (input.mask && !selection.backend.capabilities.mask) throw imgErrors.maskUnsupported(selection.backend.kind);

  const { images, skipped } = await loadImages(input.images, {
    root: context.config.workspaceRoot,
    maxBytes: context.config.maxImageBytes,
    maxCount: context.config.maxImages,
    signal: context.signal,
    artifacts: context.artifacts,
  });
  if (images.length === 0) throw imgErrors.needsInputImages();

  const mask = input.mask
    ? (await loadImages([input.mask], { root: context.config.workspaceRoot, maxBytes: context.config.maxImageBytes, signal: context.signal, artifacts: context.artifacts })).images[0]
    : undefined;

  const request: EditRequest = {
    ...toGenerateRequest(input),
    images,
    ...(mask ? { mask } : {}),
    ...(input.input_fidelity === undefined ? {} : { inputFidelity: input.input_fidelity }),
  };

  const started = Date.now();
  const result = await selection.backend.edit(request, context);
  const outcome = await finalize(result, input, context, selection.backend.kind, Date.now() - started);
  if (skipped.length > 0) {
    outcome.notes.push(`Skipped ${skipped.length} input image(s): ${skipped.map((entry) => `${entry.source} (${entry.reason})`).join("; ")}`);
  }
  if (mask) outcome.notes.push("Mask applied.");
  return outcome;
}

function toGenerateRequest(input: GenerateOperationInput): GenerateRequest {
  return {
    prompt: input.prompt,
    n: Math.max(1, Math.trunc(input.n)),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.aspect_ratio === undefined ? {} : { aspectRatio: input.aspect_ratio }),
    ...(input.quality === undefined ? {} : { quality: input.quality }),
    ...(input.output_format === undefined ? {} : { outputFormat: input.output_format }),
    ...(input.background === undefined ? {} : { background: input.background }),
    ...(input.output_compression === undefined ? {} : { outputCompression: input.output_compression }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.negative_prompt === undefined ? {} : { negativePrompt: input.negative_prompt }),
    ...(input.style === undefined ? {} : { style: input.style }),
    ...(input.user === undefined ? {} : { user: input.user }),
  };
}

async function finalize(
  result: { images: RenderedImage[]; model: string; backend: BackendKind; usage?: Usage; notes?: string },
  input: GenerateOperationInput,
  context: OperationContext,
  backend: BackendKind,
  durationMs: number,
): Promise<OperationOutcome> {
  const notes: string[] = [];
  if (result.notes) notes.push(result.notes);

  const shouldSave = input.save !== false;
  const shouldInline = input.inline !== false;
  const pathOpts = pathOptions(context.config);
  const images: SavedImage[] = [];
  const content: ContentBlock[] = [];

  let inlineBudget = MAX_INLINE_IMAGE_BYTES;
  let inlinedCount = 0;
  const baseFilename = input.filename ?? filenameFromPrompt(input.prompt);
  const multi = result.images.length > 1;

  for (const [index, image] of result.images.entries()) {
    const extension = extensionForMime(image.mimeType);
    const saved: SavedImage = {
      index: index + 1,
      label: multi ? `${baseFilename}-${index + 1}${extension}` : `${baseFilename}${extension}`,
      mimeType: image.mimeType,
      bytes: image.data.byteLength,
      inlined: false,
      ...(imageDimensions(image.data, image.mimeType) ?? {}),
    };

    if (shouldSave) {
      const target = await resolveOutputFile(
        {
          outputPath: input.output_path,
          outputDir: input.output_dir,
          filename: input.filename,
          defaultFilename: multi ? `${baseFilename}-${index + 1}` : baseFilename,
          extension,
        },
        pathOpts,
      );
      const targetPath = multi && index > 0 ? suffixPath(target, index) : target;
      const policy = input.overwrite === true && !multi ? "overwrite" : "suffix";
      const written = await saveFile(targetPath, image.data, { policy, options: pathOpts });
      saved.path = written.path;
      saved.fileUri = `file://${written.path}`;
    }

    if (shouldInline && inlinedCount < MAX_INLINE_IMAGES && image.data.byteLength <= inlineBudget) {
      inlineBudget -= image.data.byteLength;
      inlinedCount += 1;
      saved.inlined = true;
      content.push(imageContent({ data: image.data, mimeType: image.mimeType, base64: image.data.toString("base64"), bytes: image.data.byteLength, source: "generated" }));
    }

    if (shouldSave && saved.path) {
      const blocks = artifactBlocks({
        store: context.artifacts,
        path: saved.path,
        kind: "image",
        bytes: image.data.byteLength,
        mimeType: image.mimeType,
        label: saved.label,
        root: context.config.workspaceRoot,
      });
      content.push(...blocks);
      const artifactBlock = blocks.find((block) => block.type === "text" && block.text.includes("Artifact:"));
      if (artifactBlock && artifactBlock.type === "text") {
        const match = /Artifact: (\S+)/.exec(artifactBlock.text);
        if (match?.[1]) saved.artifactUri = match[1];
      }
    }

    images.push(saved);
  }

  if (shouldInline && inlinedCount < result.images.length) {
    notes.push(
      `Inlined ${inlinedCount}/${result.images.length} image(s) (budget ${formatBytes(MAX_INLINE_IMAGE_BYTES)} / ${MAX_INLINE_IMAGES} images). Files on disk are authoritative.`,
    );
  }

  const summary = renderSummary(result, images, { shouldSave, backend, notes });
  content.push(text(summary));

  return {
    images,
    model: result.model,
    backend,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    notes,
    content,
    summary,
    structured: {
      model: result.model,
      backend,
      images: images.map((image) => ({
        index: image.index,
        label: image.label,
        mimeType: image.mimeType,
        bytes: image.bytes,
        ...(image.width === undefined ? {} : { width: image.width }),
        ...(image.height === undefined ? {} : { height: image.height }),
        ...(image.path === undefined ? {} : { path: image.path }),
        ...(image.artifactUri === undefined ? {} : { artifact: image.artifactUri }),
      })),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(notes.length > 0 ? { notes } : {}),
      durationMs,
    },
    durationMs,
  };
}

function renderSummary(
  result: { model: string; usage?: Usage },
  images: SavedImage[],
  options: { shouldSave: boolean; backend: BackendKind; notes: string[] },
): string {
  const lines: string[] = [];
  lines.push(`Generated ${images.length} image(s) with ${result.model} (backend: ${options.backend}).`);
  for (const image of images) {
    const dimensions = image.width && image.height ? `, ${image.width}x${image.height}` : "";
    const location = image.path ? image.path : "(not saved)";
    lines.push(`  ${image.index}. ${location} — ${image.mimeType}, ${formatBytes(image.bytes)}${dimensions}`);
  }
  if (!options.shouldSave) lines.push("save: false — nothing was written to disk.");
  if (result.usage) {
    const parts: string[] = [];
    if (result.usage.inputTokens !== undefined) parts.push(`in ${result.usage.inputTokens}`);
    if (result.usage.outputTokens !== undefined) parts.push(`out ${result.usage.outputTokens}`);
    if (result.usage.totalTokens !== undefined) parts.push(`total ${result.usage.totalTokens}`);
    if (result.usage.costUsd !== undefined) parts.push(`cost $${result.usage.costUsd.toFixed(4)}`);
    if (parts.length > 0) lines.push(`usage: ${parts.join(", ")}`);
  }
  for (const note of options.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}
