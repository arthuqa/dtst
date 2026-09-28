import { describe, expect, it } from "vitest";
import {
  extensionForMime,
  isProbablyBase64,
  isTextMime,
  parseDataUrl,
  sniffMime,
  toDataUrl,
} from "@dtst/internal";
import { makePng } from "./helpers";

const PNG = makePng();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const GIF = Buffer.from("GIF89a\u0000\u0000", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"), Buffer.from([0, 0, 0, 0])]);
const BMP = Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypavif", "ascii"), Buffer.from([0, 0, 0, 0])]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");

describe("sniffMime", () => {
  it.each([
    ["png", PNG, "image/png", true],
    ["jpeg", JPEG, "image/jpeg", true],
    ["gif", GIF, "image/gif", true],
    ["webp", WEBP, "image/webp", true],
    ["bmp", BMP, "image/bmp", false],
    ["tiff (little endian)", TIFF_LE, "image/tiff", false],
    ["tiff (big endian)", TIFF_BE, "image/tiff", false],
    ["avif", AVIF, "image/avif", false],
    ["svg", SVG, "image/svg+xml", false],
  ])("detects %s", (_name, bytes, mimeType, widelySupported) => {
    expect(sniffMime(bytes)).toEqual({ mimeType, widelySupported });
  });

  it("falls back to a declared content type for unknown bytes", () => {
    expect(sniffMime(Buffer.from("garbage"), "image/png")).toEqual({ mimeType: "image/png", widelySupported: true });
    expect(sniffMime(Buffer.from("garbage"), "text/plain")).toBeUndefined();
    expect(sniffMime(Buffer.from("garbage"))).toBeUndefined();
  });
});

describe("extensionForMime", () => {
  it("maps known mime types (case-insensitively) and falls back", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("IMAGE/JPEG")).toBe(".jpg");
    expect(extensionForMime("image/svg+xml;charset=utf-8")).toBe(".svg");
    expect(extensionForMime("application/octet-stream")).toBe(".bin");
  });
});

describe("parseDataUrl", () => {
  it("parses base64 payloads", () => {
    const parsed = parseDataUrl(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(parsed?.mimeType).toBe("image/png");
    expect(parsed?.data.equals(PNG)).toBe(true);
    expect(parsed?.base64).toBe(PNG.toString("base64"));
  });

  it("parses URL-encoded payloads", () => {
    const parsed = parseDataUrl("data:text/plain,hello%20world");
    expect(parsed?.mimeType).toBe("text/plain");
    expect(parsed?.data.toString("utf8")).toBe("hello world");
  });

  it("accepts an empty base64 payload", () => {
    const parsed = parseDataUrl("data:image/png;base64,");
    expect(parsed?.mimeType).toBe("image/png");
    expect(parsed?.data.byteLength).toBe(0);
  });

  it("returns undefined for non data URLs", () => {
    expect(parseDataUrl("not a data url")).toBeUndefined();
  });
});

describe("toDataUrl", () => {
  it("builds a normalised data URL", () => {
    expect(toDataUrl("image/png", "AAAA")).toBe("data:image/png;base64,AAAA");
    expect(toDataUrl("Image/PNG", "AAAA")).toBe("data:image/png;base64,AAAA");
    expect(toDataUrl("", "AAAA")).toBe("data:application/octet-stream;base64,AAAA");
  });
});

describe("isProbablyBase64", () => {
  it("accepts long, padded, multiple-of-four base64", () => {
    expect(isProbablyBase64(PNG.toString("base64"))).toBe(true);
    expect(isProbablyBase64("A".repeat(32))).toBe(true);
    expect(isProbablyBase64("QUJD".repeat(8))).toBe(true);
  });

  it("rejects short strings, invalid characters and bad lengths", () => {
    expect(isProbablyBase64("hello")).toBe(false);
    expect(isProbablyBase64("a".repeat(31))).toBe(false);
    expect(isProbablyBase64("!".repeat(40))).toBe(false);
    expect(isProbablyBase64("aGVsbG8=")).toBe(false);
  });
});

describe("isTextMime", () => {
  it("classifies text-ish mime types", () => {
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("image/svg+xml")).toBe(true);
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("")).toBe(false);
  });
});
