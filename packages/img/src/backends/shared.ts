/**
 * Helpers shared by the three image backends.
 */

import { toFile, type Uploadable } from "openai";
import { DtstError, type LoadedImage, type Logger, fetchBinary, normalizeMime, sniffMime } from "@dtst/internal";
import type { RenderedImage } from "./types";

export const OUTPUT_FORMAT_MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function mimeFromOutputFormat(format: string | undefined, fallback = "image/png"): string {
  if (!format) return fallback;
  return OUTPUT_FORMAT_MIME[format.toLowerCase()] ?? fallback;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | undefined;
  for (const value of [candidate?.status, candidate?.statusCode, candidate?.response?.status]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

/**
 * Detect "the provider does not know this parameter" responses, which are the
 * signal to retry with a minimal body instead of failing the whole call.
 */
export function isUnsupportedParameterError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined && status !== 400 && status !== 404 && status !== 422) return false;
  const message = errorMessage(error).toLowerCase();
  if (status === 404) {
    return /not found|unsupported|unknown (endpoint|route|url)|no such/i.test(message) || message.trim() === "";
  }
  return /unknown (parameter|field|argument)|unrecognized|unsupported (parameter|field|value|option)|not supported|invalid[_ ]?(parameter|field)|extra (field|input)|unexpected (property|field|keyword)/i.test(
    message,
  );
}

/** Drop keys whose value is `undefined` so optional params are omitted. */
export function compact<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
}

export function bufferFromBase64(base64: string): Buffer {
  const cleaned = base64.replace(/\s+/g, "");
  return Buffer.from(cleaned, "base64");
}

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

export function parseDataUrlSafe(value: string): { mimeType: string; data: Buffer } | undefined {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/s.exec(value);
  if (!match) return undefined;
  const mimeType = normalizeMime(match[1] ?? "application/octet-stream") || "application/octet-stream";
  const payload = match[3] ?? "";
  if ((match[2] ?? "").includes(";base64")) return { mimeType, data: bufferFromBase64(payload) };
  return { mimeType, data: Buffer.from(decodeURIComponent(payload), "utf8") };
}

/** Turn a provider response entry (b64 or URL) into bytes. */
export async function renderedImageFrom(
  entry: { b64_json?: string | null; url?: string | null; media_type?: string | null },
  options: { fallbackMime: string; signal: AbortSignal; log?: Logger },
): Promise<RenderedImage> {
  const base64 = entry.b64_json ?? undefined;
  if (base64) {
    const data = bufferFromBase64(base64);
    const sniffed = sniffMime(data, entry.media_type ?? undefined);
    return { data, mimeType: sniffed?.mimeType ?? options.fallbackMime };
  }
  const url = entry.url ?? undefined;
  if (url) {
    if (isDataUrl(url)) {
      const parsed = parseDataUrlSafe(url);
      if (!parsed) throw new DtstError("PROVIDER_ERROR", "Provider returned a malformed data URL image.");
      const sniffed = sniffMime(parsed.data, parsed.mimeType);
      return { data: parsed.data, mimeType: sniffed?.mimeType ?? parsed.mimeType };
    }
    const downloaded = await fetchBinary(url, { signal: options.signal, maxBytes: 64 * 1024 * 1024 });
    const sniffed = sniffMime(downloaded.data, downloaded.contentType);
    return { data: downloaded.data, mimeType: sniffed?.mimeType ?? options.fallbackMime };
  }
  throw new DtstError("PROVIDER_ERROR", "Provider returned an image entry with neither b64_json nor url.");
}

export async function toUploadable(image: LoadedImage, index: number): Promise<Uploadable> {
  const extension = image.mimeType === "image/jpeg" ? "jpg" : (image.mimeType.split("/")[1] ?? "png");
  const name = image.label ?? `input-${index + 1}.${extension}`;
  return toFile(image.data, name, { type: image.mimeType });
}

export interface AttachmentSummary {
  count: number;
  bytes: number;
  totalBytes: number;
}

export function summarizeImages(images: readonly LoadedImage[]): AttachmentSummary {
  const bytes = images.reduce((total, image) => total + image.bytes, 0);
  return { count: images.length, bytes, totalBytes: images.reduce((total, image) => total + image.data.byteLength, 0) };
}
