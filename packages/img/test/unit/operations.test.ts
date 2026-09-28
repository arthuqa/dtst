import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore, resetClientCache } from "@dtst/internal";
import { runGenerate, type OperationContext } from "../../src/operations";
import {
  cleanupDir,
  jsonResponse,
  makePng,
  makeTempDir,
  recordingProgress,
  silentLogger,
  testConfig,
} from "./helpers";

const PNG = makePng();

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir("dtst-ops-");
  resetClientCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupDir(dir);
});

function stubImageFetch(): { calls: Array<{ url: string; body: Record<string, unknown> | undefined }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url.includes("/images/generations")) {
      return jsonResponse({
        created: 7,
        data: [{ b64_json: PNG.toString("base64") }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      });
    }
    return jsonResponse({ error: { message: `unexpected ${url}` } }, 500);
  });
  return { calls };
}

function makeContext(): OperationContext {
  return {
    config: testConfig({
      workspaceRoot: dir,
      imageBackend: "images",
      textModel: "gpt-image-1",
      maxRetries: 0,
    }),
    log: silentLogger(),
    progress: recordingProgress(),
    signal: new AbortController().signal,
    artifacts: new ArtifactStore(),
  };
}

function imagePaths(outcome: { structured: Record<string, unknown> }): Array<string | undefined> {
  return (outcome.structured["images"] as Array<{ path?: string }>).map((image) => image.path);
}

describe("runGenerate", () => {
  it("writes the requested file and describes the result", async () => {
    const { calls } = stubImageFetch();
    const context = makeContext();

    const outcome = await runGenerate({ prompt: "a red panda", n: 1, filename: "pic.png" }, context);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/images/generations");

    const target = path.join(dir, "pic.png");
    expect(outcome.images).toHaveLength(1);
    expect(outcome.images[0]?.path).toBe(target);
    expect(imagePaths(outcome)[0]).toBe(target);
    expect((await readFile(target)).equals(PNG)).toBe(true);

    const types = outcome.content.map((block) => block.type);
    expect(types).toContain("image");
    expect(types).toContain("resource_link");
    expect(types).toContain("text");
    expect(outcome.summary).toContain("Generated 1 image(s) with gpt-image-1");
    expect(outcome.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("writes into output_dir", async () => {
    stubImageFetch();
    const outcome = await runGenerate({ prompt: "a cat", n: 1, output_dir: "out", filename: "cat.png" }, makeContext());
    expect(outcome.images[0]?.path).toBe(path.join(dir, "out", "cat.png"));
    expect((await readFile(outcome.images[0]!.path!)).equals(PNG)).toBe(true);
  });

  it("suffixes the second identical call instead of clobbering", async () => {
    stubImageFetch();
    const first = await runGenerate({ prompt: "a cat", n: 1, filename: "pic.png" }, makeContext());
    const second = await runGenerate({ prompt: "a cat", n: 1, filename: "pic.png" }, makeContext());

    expect(path.basename(first.images[0]!.path!)).toBe("pic.png");
    expect(path.basename(second.images[0]!.path!)).toBe("pic-1.png");
  });

  it("writes nothing when save is false", async () => {
    stubImageFetch();
    const outcome = await runGenerate({ prompt: "a cat", n: 1, save: false, filename: "pic.png" }, makeContext());

    expect(outcome.images[0]?.path).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    expect(outcome.content.map((block) => block.type)).toContain("image");
    expect(outcome.summary).toContain("save: false");
  });

  it("replaces the file when overwrite is true", async () => {
    stubImageFetch();
    const first = await runGenerate({ prompt: "a cat", n: 1, filename: "pic.png" }, makeContext());
    const second = await runGenerate(
      { prompt: "a cat", n: 1, filename: "pic.png", overwrite: true },
      makeContext(),
    );

    expect(second.images[0]?.path).toBe(first.images[0]?.path);
    expect(path.basename(second.images[0]!.path!)).toBe("pic.png");
  });

  it("omits image blocks when inline is false", async () => {
    stubImageFetch();
    const outcome = await runGenerate(
      { prompt: "a cat", n: 1, filename: "pic.png", inline: false },
      makeContext(),
    );

    const types = outcome.content.map((block) => block.type);
    expect(types).not.toContain("image");
    expect(types).toContain("resource_link");
    expect(outcome.images[0]?.inlined).toBe(false);
  });
});
