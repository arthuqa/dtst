import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, gatherContext, listDirectory, renderContext } from "@dtst/internal";
import { cleanupDir, makeTempDir, makePng } from "./helpers";

let dir: string;
let alpha: string;

beforeEach(async () => {
  dir = await makeTempDir("dtst-context-");
  alpha = path.join(dir, "alpha.txt");
  await writeFile(alpha, "hello alpha");
  await writeFile(path.join(dir, ".hidden.txt"), "secret");
  await writeFile(path.join(dir, "beta.json"), '{"beta":true}');
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "sub", "inner.txt"), "inner");
});

afterEach(async () => {
  await cleanupDir(dir);
});

describe("gatherContext: sources", () => {
  it("ingests inline text chunks", async () => {
    const result = await gatherContext({ text: ["hello"] });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      source: "inline:0",
      label: "inline text #1",
      text: "hello",
      bytes: 5,
      truncated: false,
    });
    expect(result.totalBytes).toBe(5);
  });

  it("reads a file from disk", async () => {
    const result = await gatherContext({ files: [alpha] });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      source: alpha,
      label: "alpha.txt",
      text: "hello alpha",
      truncated: false,
    });
  });

  it("expands a glob relative to the root", async () => {
    const result = await gatherContext({ files: ["*.txt"] }, { root: dir });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.label).toBe("alpha.txt");
  });

  it("reports a glob that matches nothing without throwing", async () => {
    const result = await gatherContext({ files: ["*.nope"] }, { root: dir });
    expect(result.chunks).toHaveLength(0);
    expect(result.skipped).toEqual([{ source: "*.nope", reason: "glob matched no files" }]);
  });

  it("reports a missing file without throwing", async () => {
    const missing = path.join(dir, "nope.txt");
    const result = await gatherContext({ files: [missing] });
    expect(result.chunks).toHaveLength(0);
    expect(result.skipped).toEqual([{ source: missing, reason: "file not found" }]);
  });

  it("walks a directory, skipping hidden files and subdirectories", async () => {
    const result = await gatherContext({ dirs: [dir] });
    const labels = result.chunks.map((chunk) => chunk.label).sort();
    expect(labels).toEqual(["alpha.txt", "beta.json"]);

    for (const chunk of result.chunks) expect(chunk.source).not.toContain(".hidden");
    const subSkip = result.skipped.find((entry) => entry.source.endsWith("sub"));
    expect(subSkip?.reason).toBe("subdirectory skipped (not recursive)");
  });

  it("loads images found by a glob", async () => {
    await writeFile(path.join(dir, "pic.png"), makePng(2, 3));
    const result = await gatherContext({ files: ["*.png"] }, { root: dir });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mimeType: "image/png", width: 2, height: 3 });
    expect(result.chunks[0]?.text).toContain("[image: pic.png");
  });
});

describe("gatherContext: budgets", () => {
  it("truncates a source at maxPerSourceBytes", async () => {
    const big = path.join(dir, "big.txt");
    await writeFile(big, "a".repeat(200));
    const result = await gatherContext({ files: [big] }, { maxPerSourceBytes: 50 });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.bytes).toBe(50);
    expect(result.chunks[0]?.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("truncates once the total budget is exhausted", async () => {
    const result = await gatherContext({ text: ["x".repeat(100), "y".repeat(100)] }, { maxTotalBytes: 120 });
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.bytes).toBe(100);
    expect(result.chunks[0]?.truncated).toBe(false);
    expect(result.chunks[1]?.truncated).toBe(true);
    expect(result.chunks[1]?.text).toContain("[truncated at 120 B total]");
    expect(result.truncated).toBe(true);
  });
});

describe("gatherContext: artifacts", () => {
  it("resolves an artifact URI and reads its file", async () => {
    const store = new ArtifactStore();
    const artifact = store.save({ path: alpha, kind: "text", bytes: 11, mimeType: "text/plain", label: "alpha.txt" });
    const result = await gatherContext({ artifacts: [artifact.uri] }, { artifacts: store });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({ source: alpha, text: "hello alpha" });
  });

  it("reports an unknown artifact reference", async () => {
    const store = new ArtifactStore();
    const result = await gatherContext({ artifacts: ["dtst://artifact/deadbeef"] }, { artifacts: store });
    expect(result.skipped).toEqual([
      { source: "dtst://artifact/deadbeef", reason: "artifact not found in this session" },
    ]);
  });
});

describe("renderContext", () => {
  it("fences chunks and carries the untrusted-data warning", async () => {
    const result = await gatherContext({ files: [alpha] });
    const rendered = renderContext(result);
    expect(rendered).toContain("untrusted reference data");
    expect(rendered).toContain("--- BEGIN alpha.txt");
    expect(rendered).toContain("hello alpha");
    expect(rendered).toContain("--- END alpha.txt ---");
  });

  it("returns an empty string with no chunks", () => {
    expect(renderContext({ chunks: [] })).toBe("");
  });
});

describe("listDirectory", () => {
  it("respects maxFiles and reports the budget", async () => {
    const { files, skipped } = await listDirectory(dir, 2);
    expect(files).toHaveLength(2);
    expect(skipped.some((entry) => entry.reason === "file budget of 2 reached")).toBe(true);
  });

  it("reports a missing directory", async () => {
    const { files, skipped } = await listDirectory(path.join(dir, "does-not-exist"));
    expect(files).toEqual([]);
    expect(skipped[0]?.reason).toBe("directory not found");
  });
});
