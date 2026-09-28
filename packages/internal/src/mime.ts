/**
 * MIME handling without a dependency: images are the only binary payload this
 * project moves, so magic-byte sniffing plus a small extension table is both
 * sufficient and faster than pulling in `file-type`.
 */

export interface SniffResult {
  mimeType: string;
  /** Whether the bytes are a format every major provider accepts. */
  widelySupported: boolean;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

const WIDELY_SUPPORTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export function extensionForMime(mimeType: string): string {
  return IMAGE_EXTENSIONS[normalizeMime(mimeType)] ?? ".bin";
}

export function mimeForExtension(extension: string): string | undefined {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return EXTENSION_MIME[ext.toLowerCase()];
}

export function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
}

export function isImageMime(mimeType: string): boolean {
  return normalizeMime(mimeType).startsWith("image/");
}

export function isPng(mimeType: string): boolean {
  return normalizeMime(mimeType) === "image/png";
}

/** True when the mime type is a text-ish format safe to inline into a prompt. */
export function isTextMime(mimeType: string): boolean {
  const mime = normalizeMime(mimeType);
  if (!mime) return false;
  if (mime.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
    "application/x-httpd-php",
    "application/sql",
    "application/graphql",
    "image/svg+xml",
  ].includes(mime);
}

/**
 * Sniff an image format from the leading bytes. Falls back to the optional
 * `contentType` when the bytes are inconclusive.
 */
export function sniffMime(buffer: Uint8Array, contentType?: string): SniffResult | undefined {
  const mime = sniffBytes(buffer);
  if (mime) return { mimeType: mime, widelySupported: WIDELY_SUPPORTED.has(mime) };

  const declared = contentType ? normalizeMime(contentType) : "";
  if (declared && isImageMime(declared)) {
    return { mimeType: declared, widelySupported: WIDELY_SUPPORTED.has(declared) };
  }
  return undefined;
}

function sniffBytes(buffer: Uint8Array): string | undefined {
  const bytes = buffer;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00))
  ) {
    return "image/tiff";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
  }
  // SVG is text: allow a BOM, XML prolog and whitespace before the root tag.
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

export interface ParsedDataUrl {
  mimeType: string;
  base64: string;
  data: Buffer;
}

/** Parse `data:image/png;base64,...` into mime + bytes. Throws nothing. */
export function parseDataUrl(value: string): ParsedDataUrl | undefined {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/s.exec(value.trim());
  if (!match) return undefined;
  const mimeType = normalizeMime(match[1] ?? "text/plain") || "text/plain";
  const params = match[2] ?? "";
  const payload = match[3] ?? "";
  if (params.includes(";base64")) {
    return { mimeType, base64: payload, data: Buffer.from(payload, "base64") };
  }
  return { mimeType, base64: Buffer.from(payload, "utf8").toString("base64"), data: Buffer.from(decodeURIComponent(payload), "utf8") };
}

export function toDataUrl(mimeType: string, base64: string): string {
  return `data:${normalizeMime(mimeType) || "application/octet-stream"};base64,${base64}`;
}

export function isProbablyBase64(value: string): boolean {
  const trimmed = value.replace(/\s+/g, "");
  if (trimmed.length < 32 || trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}
