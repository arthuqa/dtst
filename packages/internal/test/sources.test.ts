import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageSize, mimeForExtension, parseDataUrl, sniffImage } from "../src/mime";
import { loadImages, loadInputs } from "../src/sources";
import { type FakeProvider, PNG_1x1, WEBP_HEADER, fakeProvider, pngOfSize, tempDir } from "./helpers";

let root: string;
let provider: FakeProvider;

beforeAll(async () => {
  root = tempDir();
  writeFileSync(path.join(root, "notes.md"), "# Notes\nhello");
  writeFileSync(path.join(root, "pixel.png"), PNG_1x1);
  writeFileSync(path.join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
  writeFileSync(path.join(root, "long.txt"), "x".repeat(5000));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs", "a.md"), "A");
  writeFileSync(path.join(root, "docs", "b.md"), "B");
  writeFileSync(path.join(root, "docs", ".hidden"), "H");
  provider = await fakeProvider();
  provider.on("GET /page", { body: "plain page" });
  provider.on("GET /pic", { body: PNG_1x1 });
});
afterAll(() => provider.close());

describe("loadInputs", () => {
  it("reads text files, images, folders and globs", async () => {
    const { inputs, skipped } = await loadInputs(["notes.md", "pixel.png", "docs", "docs/*.md"], { root });
    expect(skipped).toEqual([]);
    expect(inputs.map((input) => [path.basename(input.source), input.kind])).toEqual([
      ["notes.md", "text"],
      ["pixel.png", "image"],
      ["a.md", "text"],
      ["b.md", "text"],
      ["a.md", "text"],
      ["b.md", "text"],
    ]);
    expect(inputs[1]).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
  });

  it("decodes data URLs and raw base64; fetches URLs", async () => {
    const base64 = Buffer.concat([PNG_1x1, Buffer.alloc(30)]).toString("base64");
    const { inputs } = await loadInputs(
      [`data:image/png;base64,${PNG_1x1.toString("base64")}`, base64, `${provider.url}/page`, `${provider.url}/pic`],
      { root },
    );
    expect(inputs.map((input) => input.kind)).toEqual(["image", "image", "text", "image"]);
    expect(inputs[2]).toMatchObject({ text: "plain page" });
  });

  it("truncates long text and skips missing or binary files", async () => {
    const { inputs, skipped } = await loadInputs(["long.txt", "missing.md", "blob.bin", "none/*.md"], {
      root,
      maxTextBytes: 1024,
    });
    expect(inputs[0]).toMatchObject({ kind: "text", truncated: true });
    expect((inputs[0] as { text: string }).text).toHaveLength(1024);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/Not found/),
      "binary file",
      "glob matched no files",
    ]);
  });
});

describe("loadImages", () => {
  it("fails loudly when an input is missing or not an image", async () => {
    await expect(loadImages(["pixel.png"], { root })).resolves.toHaveLength(1);
    await expect(loadImages(["pixel.png", "notes.md", "nope.png"], { root })).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringMatching(/notes\.md: not an image.*|nope\.png/),
    });
  });
});

describe("mime", () => {
  it("sniffs formats and reads dimensions", () => {
    expect(sniffImage(PNG_1x1)).toBe("image/png");
    expect(sniffImage(WEBP_HEADER)).toBe("image/webp");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("<?xml version='1.0'?><svg></svg>"))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("hello"))).toBeUndefined();
    expect(imageSize(pngOfSize(1536, 1024), "image/png")).toEqual({ width: 1536, height: 1024 });
  });

  it("maps extensions and parses data URLs", () => {
    expect(mimeForExtension(".JPEG")).toBe("image/jpeg");
    expect(mimeForExtension("webp")).toBe("image/webp");
    expect(parseDataUrl("data:text/plain,hi%20there")).toEqual({
      mimeType: "text/plain",
      data: Buffer.from("hi there"),
    });
  });
});
