/** Image type sniffing and intrinsic dimensions, without dependencies. */

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? ".bin";
}

export function mimeForExtension(extension: string): string | undefined {
  const ext = extension.toLowerCase().replace(/^\.?/, ".");
  if (ext === ".jpeg") return "image/jpeg";
  return Object.entries(EXTENSIONS).find(([, value]) => value === ext)?.[0];
}

/** Detect an image format from its leading bytes. */
export function sniffImage(data: Uint8Array): string | undefined {
  const ascii = (start: number, end: number): string => String.fromCharCode(...data.subarray(start, end));
  if (data[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  const head = ascii(0, Math.min(data.length, 512))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

export function imageSize(data: Buffer, mimeType: string): { width: number; height: number } | undefined {
  try {
    if (mimeType === "image/png" && data.length >= 24)
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (mimeType === "image/gif" && data.length >= 10)
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (mimeType === "image/webp" && data.length >= 30) {
      const chunk = data.toString("ascii", 12, 16);
      if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = data[offset + 1] ?? 0;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
        }
        offset += 2 + data.readUInt16BE(offset + 2);
      }
    }
  } catch {
    // Malformed header: dimensions are best-effort.
  }
  return undefined;
}

/** `data:<mime>;base64,<payload>` → bytes. */
export function parseDataUrl(value: string): { mimeType: string; data: Buffer } | undefined {
  const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(value.trim());
  if (!match) return undefined;
  const mimeType = (match[1] || "text/plain").toLowerCase();
  const payload = match[3] ?? "";
  const data = match[2]?.includes(";base64")
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return { mimeType, data };
}

export function toDataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString("base64")}`;
}
