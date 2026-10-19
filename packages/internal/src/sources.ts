/**
 * Turn caller references into text or image inputs. A reference may be a file path, a glob,
 * a directory (non-recursive), a `file://` URI, an http(s) URL, a `data:` URL or raw base64.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import { DtstError, toDtstError } from "./errors";
import { download } from "./http";
import { imageSize, parseDataUrl, sniffImage } from "./mime";
import { resolvePath } from "./files";

export interface TextInput {
  kind: "text";
  source: string;
  text: string;
  truncated: boolean;
}

export interface ImageInput {
  kind: "image";
  source: string;
  data: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
}

export type Input = TextInput | ImageInput;

export interface LoadOptions {
  root: string;
  signal?: AbortSignal | undefined;
  /** Per-source cap for text; longer text is truncated. Default 256 KiB. */
  maxTextBytes?: number;
  /** Per-image cap. Default 20 MiB. */
  maxImageBytes?: number;
  /** Cap on files expanded from globs and directories. Default 100. */
  maxFiles?: number;
}

export interface LoadResult {
  inputs: Input[];
  skipped: { source: string; reason: string }[];
}

const GLOB = /[*?[\]{}]/;
const IGNORED = ["**/node_modules/**", "**/.git/**"];

export async function loadInputs(references: readonly string[], options: LoadOptions): Promise<LoadResult> {
  const maxFiles = options.maxFiles ?? 100;
  const result: LoadResult = { inputs: [], skipped: [] };
  const skip = (source: string, reason: string): void => void result.skipped.push({ source, reason });

  for (const raw of references) {
    const reference = raw.trim();
    if (!reference) continue;
    try {
      if (/^https?:\/\//i.test(reference)) {
        result.inputs.push(await loadUrl(reference, options));
      } else if (reference.startsWith("data:")) {
        const parsed = parseDataUrl(reference);
        if (!parsed) throw new DtstError("BAD_INPUT", "Malformed data URL.");
        result.inputs.push(classify("data:", parsed.data, false));
      } else if (GLOB.test(reference) && !reference.startsWith("file:")) {
        const matches = await glob(reference, { cwd: options.root, absolute: true, onlyFiles: true, ignore: IGNORED });
        if (matches.length === 0) skip(reference, "glob matched no files");
        if (matches.length > maxFiles)
          skip(reference, `only the first ${maxFiles} of ${matches.length} matches were read`);
        for (const file of matches.sort().slice(0, maxFiles)) await loadFile(file, options, result);
      } else {
        const file = reference.startsWith("file:") ? fileURLToPath(reference) : resolvePath(reference, options.root);
        await loadPath(file, reference, options, result);
      }
    } catch (error) {
      skip(reference, toDtstError(error).message);
    }
  }
  return result;
}

async function loadPath(file: string, reference: string, options: LoadOptions, result: LoadResult): Promise<void> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) {
    if (isBase64(reference)) {
      result.inputs.push(classify("base64", Buffer.from(reference.replace(/\s+/g, ""), "base64"), false));
      return;
    }
    throw new DtstError("NOT_FOUND", `Not found: ${file}`);
  }
  if (!stat.isDirectory()) return loadFile(file, options, result);

  const entries: Dirent[] = await fs.readdir(file, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => path.join(file, entry.name))
    .sort();
  const maxFiles = options.maxFiles ?? 100;
  if (files.length > maxFiles)
    result.skipped.push({ source: file, reason: `only the first ${maxFiles} files were read` });
  for (const entry of files.slice(0, maxFiles)) await loadFile(entry, options, result);
}

async function loadFile(file: string, options: LoadOptions, result: LoadResult): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 512));
    await handle.read(head, 0, head.length, 0);
    const isImage = sniffImage(head) !== undefined;
    const limit = isImage ? (options.maxImageBytes ?? 20 * 1024 * 1024) : (options.maxTextBytes ?? 256 * 1024);
    if (isImage && size > limit) throw new DtstError("BAD_INPUT", `Image is over ${limit} bytes: ${file}`);
    const data = Buffer.alloc(Math.min(size, limit));
    await handle.read(data, 0, data.length, 0);
    const input = classify(file, data, size > data.length);
    if (input.kind === "text" && head.includes(0)) {
      result.skipped.push({ source: file, reason: "binary file" });
      return;
    }
    result.inputs.push(input);
  } catch (error) {
    result.skipped.push({ source: file, reason: toDtstError(error).message });
  } finally {
    await handle.close();
  }
}

async function loadUrl(url: string, options: LoadOptions): Promise<Input> {
  const maxText = options.maxTextBytes ?? 256 * 1024;
  const maxImage = options.maxImageBytes ?? 20 * 1024 * 1024;
  const { data, contentType, truncated } = await download(url, {
    maxBytes: Math.max(maxText, maxImage),
    truncate: true,
    signal: options.signal,
  });
  const isImage = sniffImage(data) !== undefined;
  if (isImage && truncated) throw new DtstError("BAD_INPUT", `Image is over ${maxImage} bytes: ${url}`);
  if (!isImage && data.subarray(0, 8192).includes(0)) {
    throw new DtstError("BAD_INPUT", `Binary content (${contentType || "unknown type"}) is not supported.`);
  }
  return classify(url, isImage ? data : data.subarray(0, maxText), truncated || data.length > maxText);
}

function classify(source: string, data: Buffer, truncated: boolean): Input {
  const mimeType = sniffImage(data);
  if (mimeType) return { kind: "image", source, data, mimeType, ...imageSize(data, mimeType) };
  const text = data.toString("utf8");
  // A cut can land inside a multi-byte character; drop the replacement char it produces.
  return { kind: "text", source, text: truncated ? text.replace(/\uFFFD$/, "") : text, truncated };
}

function isBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return compact.length >= 64 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

/** Load references that must all be images (edit inputs, masks); any failure is an error. */
export async function loadImages(references: readonly string[], options: LoadOptions): Promise<ImageInput[]> {
  const { inputs, skipped } = await loadInputs(references, options);
  const notImages = inputs.filter((input) => input.kind !== "image").map((input) => input.source);
  const problems = [
    ...skipped.map((entry) => `${entry.source}: ${entry.reason}`),
    ...notImages.map((s) => `${s}: not an image`),
  ];
  if (problems.length > 0) {
    throw new DtstError(
      "BAD_INPUT",
      `Could not load image input(s): ${problems.join("; ")}`,
      "Pass image file paths, globs, URLs, data URLs or base64.",
    );
  }
  return inputs as ImageInput[];
}
