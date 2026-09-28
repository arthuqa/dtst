/**
 * Image input handling.
 *
 * Agents pass images as file paths, globs, http(s) URLs, `data:` URLs, raw
 * base64, `file://` URIs or artifact URIs. All of those are normalized here
 * into `LoadedImage` values with verified bytes, a sniffed MIME type, and
 * provider-ready base64.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { ArtifactStore } from "./artifacts";
import { DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGES } from "./config";
import { DtstError, badInput } from "./errors";
import { fetchBinary } from "./http";
import { logger } from "./log";
import { isImageMime, isProbablyBase64, normalizeMime, parseDataUrl, sniffMime, toDataUrl } from "./mime";
import { resolveUserPath, workspaceRoot } from "./paths";

export interface ImageLimits {
  /** Per-image byte limit. Default 25 MiB (OpenAI's cap). */
  maxBytes?: number;
  /** Maximum number of images accepted in one call. Default 16. */
  maxCount?: number;
}

export interface LoadedImage {
  /** Raw bytes. */
  data: Buffer;
  /** Sniffed or declared MIME type, e.g. `image/png`. */
  mimeType: string;
  /** Base64 payload without the data-URL prefix. */
  base64: string;
  bytes: number;
  /** Where the image came from: normalized path, URL or `data:`. */
  source: string;
  /** Short human-readable name (file name or URL basename). */
  label?: string;
  /** Absolute path when the image came from disk. */
  path?: string;
  width?: number;
  height?: number;
}

export interface LoadImagesOptions extends ImageLimits {
  /** Base directory for relative paths and globs. Defaults to `process.cwd()`. */
  root?: string;
  /** Root directories that reads are confined to, when configured. */
  allowedReadRoots?: readonly string[];
  signal?: AbortSignal;
  artifacts?: ArtifactStore;
  /** Keep duplicates instead of de-duplicating identical sources. */
  allowDuplicates?: boolean;
  /** Values starting with `http` are only fetched when true (default true). */
  allowRemote?: boolean;
}

export const GLOB_CHARS = /[*?[\]{}]/;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function looksLikeImageReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("data:") || trimmed.startsWith("file://") || trimmed.startsWith("artifact://") || trimmed.startsWith("dtst://")) {
    return true;
  }
  if (isHttpUrl(trimmed)) return true;
  if (GLOB_CHARS.test(trimmed)) return true;
  return true;
}

/** Human-readable image summary for tool output. */
export function describeImage(image: LoadedImage): string {
  const size = image.width && image.height ? `${image.width}x${image.height}` : undefined;
  const parts = [
    image.label ?? image.source,
    image.mimeType,
    `${formatBytes(image.bytes)}${size ? `, ${size}` : ""}`,
  ];
  return parts.join(" · ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Expand globs, then load every entry. Mirrors with an unreadable path throw. */
export async function loadImages(
  sources: readonly (string | ImageInputObject)[],
  options: LoadImagesOptions = {},
): Promise<{ images: LoadedImage[]; skipped: Array<{ source: string; reason: string }> }> {
  const maxCount = options.maxCount ?? DEFAULT_MAX_IMAGES;
  const skipped: Array<{ source: string; reason: string }> = [];
  const expanded: string[] = [];

  for (const source of sources) {
    if (typeof source !== "string") {
      expanded.push(encodeObjectSource(source));
      continue;
    }
    const trimmed = source.trim();
    if (!trimmed) continue;
    if (!GLOB_CHARS.test(trimmed)) {
      expanded.push(trimmed);
      continue;
    }
    const matches = await expandGlob(trimmed, options);
    if (matches.length === 0) {
      skipped.push({ source: trimmed, reason: "glob matched no files" });
      continue;
    }
    expanded.push(...matches);
  }

  const images: LoadedImage[] = [];
  const seen = new Set<string>();
  for (const source of expanded) {
    if (images.length >= maxCount) {
      skipped.push({ source, reason: `exceeded the ${maxCount} image limit` });
      continue;
    }
    let image: LoadedImage;
    try {
      image = await loadImage(source, options);
    } catch (error) {
      if (isRecoverable(error) && options.artifacts) {
        skipped.push({ source, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      throw error;
    }
    if (!options.allowDuplicates && image.path) {
      if (seen.has(image.path)) {
        skipped.push({ source, reason: "duplicate of an earlier image" });
        continue;
      }
      seen.add(image.path);
    }
    images.push(image);
  }
  return { images, skipped };
}

function isRecoverable(error: unknown): boolean {
  return error instanceof DtstError && (error.code === "NOT_FOUND" || error.code === "BAD_INPUT");
}

const OBJECT_PREFIX = "\u0000obj:";

function encodeObjectSource(source: ImageInputObject): string {
  const value = source.data ?? source.base64 ?? source.url ?? source.path ?? source.file;
  if (!value) throw badInput("Each image entry needs one of: path, file, url, data, base64.");
  const mime = source.mimeType ?? source.mime_type;
  if (mime) return `${OBJECT_PREFIX}${mime}\u0000${value}`;
  if (source.data ?? source.base64) return `${OBJECT_PREFIX}image/png\u0000${value}`;
  return value;
}

export interface ImageInputObject {
  path?: string;
  file?: string;
  url?: string;
  /** Raw base64 or a full `data:` URL. */
  data?: string;
  base64?: string;
  mimeType?: string;
  mime_type?: string;
}

async function expandGlob(pattern: string, options: LoadImagesOptions): Promise<string[]> {
  const root = workspaceRoot(options);
  const matches = await glob(pattern, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
    expandDirectories: false,
    caseSensitiveMatch: false,
  });
  return matches.map((entry) => path.resolve(entry)).sort();
}

export async function loadImage(source: string, options: LoadImagesOptions = {}): Promise<LoadedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const trimmed = source.trim();
  if (!trimmed) throw badInput("Image reference is empty.");

  if (trimmed.startsWith(OBJECT_PREFIX)) {
    const rest = trimmed.slice(OBJECT_PREFIX.length);
    const separator = rest.indexOf("\u0000");
    const declaredMime = separator === -1 ? "image/png" : rest.slice(0, separator);
    const value = separator === -1 ? rest : rest.slice(separator + 1);
    return decodeInline(value, declaredMime, maxBytes);
  }

  if (trimmed.startsWith("data:")) {
    const parsed = parseDataUrl(trimmed);
    if (!parsed) throw badInput("Malformed data URL passed as an image.");
    return finalize({ data: parsed.data, declaredMime: parsed.mimeType, source: "data:", maxBytes });
  }

  if (isHttpUrl(trimmed)) {
    if (options.allowRemote === false) {
      throw badInput(`Remote image URLs are disabled: ${trimmed}`, "Download the image first or enable remote images.");
    }
    const downloaded = await fetchBinary(trimmed, {
      maxBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return finalize({
      data: downloaded.data,
      ...(downloaded.contentType === undefined ? {} : { declaredMime: downloaded.contentType }),
      source: trimmed,
      maxBytes,
    });
  }

  if (trimmed.startsWith("artifact://") || trimmed.startsWith("dtst://")) {
    const artifact = options.artifacts?.resolve(trimmed);
    if (!artifact) {
      throw new DtstError("NOT_FOUND", `No artifact matches ${trimmed}.`, {
        hint: "Use an artifact URI returned by an earlier tool call, or pass a file path.",
      });
    }
    return loadImage(artifact.path, options);
  }

  const resolved = resolveUserPath(trimmed.startsWith("file://") ? trimmed.slice("file://".length) : trimmed, options);

  try {
    const data = await fs.readFile(resolved);
    return finalize({ data, source: resolved, label: path.basename(resolved), path: resolved, maxBytes });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" && isProbablyBase64(trimmed)) {
      return decodeInline(trimmed, guessMimeFromBase64(trimmed), maxBytes);
    }
    if (err.code === "ENOENT") {
      throw new DtstError("NOT_FOUND", `Image not found: ${resolved}`, {
        hint: "Check the path, or pass a `data:` URL / http(s) URL / raw base64 instead.",
      });
    }
    if (err.code === "EISDIR") throw badInput(`${resolved} is a directory; pass a file path or a glob.`);
    throw new DtstError("PERMISSION", `Cannot read image ${resolved}: ${err.message}`, { cause: error });
  }
}

function decodeInline(value: string, declaredMime: string, maxBytes: number): LoadedImage {
  if (value.startsWith("data:")) {
    const parsed = parseDataUrl(value);
    if (!parsed) throw badInput("Malformed data URL passed as an image.");
    return finalize({ data: parsed.data, declaredMime: parsed.mimeType, source: "data:", maxBytes });
  }
  const base64 = value.replace(/\s+/g, "");
  if (!isProbablyBase64(base64)) {
    throw badInput("Image data is neither a valid path, URL, data URL nor base64 payload.");
  }
  return finalize({ data: Buffer.from(base64, "base64"), declaredMime, source: "base64", maxBytes });
}

function finalize(input: {
  data: Buffer;
  declaredMime?: string;
  source: string;
  label?: string;
  path?: string;
  maxBytes: number;
}): LoadedImage {
  const { data, maxBytes } = input;
  if (data.byteLength === 0) throw badInput(`Image is empty: ${input.source}`);
  if (data.byteLength > maxBytes) {
    throw badInput(
      `Image is ${formatBytes(data.byteLength)}, over the ${formatBytes(maxBytes)} limit: ${input.source}`,
      "Resize the image or raise the limit with DTST_MAX_IMAGE_BYTES.",
    );
  }
  const sniffed = sniffMime(data, input.declaredMime);
  if (!sniffed) {
    throw badInput(
      `Not a recognisable image (png, jpeg, webp, gif, avif or svg): ${input.source}`,
      "Verify the file is an image and not an HTML error page or a truncated download.",
    );
  }
  const mimeType = sniffed.mimeType;
  const dimensions = imageDimensions(data, mimeType);
  return {
    data,
    mimeType,
    base64: data.toString("base64"),
    bytes: data.byteLength,
    source: input.source,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
  };
}

export function toImageDataUrl(image: LoadedImage): string {
  return toDataUrl(image.mimeType, image.base64);
}

/** OpenAI chat/image content part for a loaded image. */
export function toChatImagePart(image: LoadedImage, detail?: "auto" | "low" | "high"): {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
} {
  return {
    type: "image_url",
    image_url: detail ? { url: toImageDataUrl(image), detail } : { url: toImageDataUrl(image) },
  };
}

function guessMimeFromBase64(_value: string): string {
  return "image/png";
}

export function guessExtensionForImage(image: LoadedImage): string {
  return normalizeMime(image.mimeType) === "image/jpeg" ? ".jpg" : "";
}

/** Best-effort intrinsic dimensions for the formats providers emit. */
export function imageDimensions(data: Buffer, mimeType: string): { width: number; height: number } | undefined {
  const mime = normalizeMime(mimeType);
  try {
    if (mime === "image/png" && data.length >= 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (mime === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (mime === "image/webp" && data.length >= 30) {
      const chunk = data.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        const width = 1 + (data.readUIntLE(24, 3) & 0xffffff);
        const height = 1 + (data.readUIntLE(27, 3) & 0xffffff);
        return { width, height };
      }
      if (chunk === "VP8 " && data.length >= 30) {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L" && data.length >= 25) {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg") return jpegDimensions(data);
  } catch {
    return undefined;
  }
  return undefined;
}

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1] ?? 0;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    const segmentLength = data.readUInt16BE(offset + 2);
    if (isSof) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

export function assertImageSupported(image: LoadedImage, opts: { requireWidelySupported?: boolean } = {}): void {
  if (!isImageMime(image.mimeType)) {
    throw badInput(`Unsupported image type ${image.mimeType} for ${image.source}.`);
  }
  if (opts.requireWidelySupported && !["image/png", "image/jpeg", "image/webp"].includes(normalizeMime(image.mimeType))) {
    logger.debug("image format may not be accepted by every provider", { mimeType: image.mimeType });
  }
}
