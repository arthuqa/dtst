import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendContext } from "../../src/backends/types";
import { OpenAIImagesBackend } from "../../src/backends/openai-images";
import { makePng, loadedPng, recordingProgress, silentLogger, testConfig } from "./helpers";

const PNG = makePng();

function makeImagesClient(): {
  client: OpenAI;
  generate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn();
  const edit = vi.fn();
  const client = { images: { generate, edit } } as unknown as OpenAI;
  return { client, generate, edit };
}

function makeContext(contextConfig = testConfig()): BackendContext {
  return {
    config: contextConfig,
    log: silentLogger(),
    progress: recordingProgress(),
    signal: new AbortController().signal,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIImagesBackend.generate", () => {
  it("sends the composed prompt and optional parameters, then decodes b64", async () => {
    const { client, generate } = makeImagesClient();
    generate.mockResolvedValue({
      created: 42,
      data: [{ b64_json: PNG.toString("base64") }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });
    const backend = new OpenAIImagesBackend(client);
    const context = makeContext();

    const result = await backend.generate(
      { prompt: "a cat", style: "ink", n: 2, size: "512x512", quality: "high", outputFormat: "png" },
      context,
    );

    const body = generate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body["prompt"]).toContain("a cat");
    expect(body["prompt"]).toContain("Style: ink");
    expect(body).toMatchObject({
      model: "test-image-model",
      n: 2,
      size: "512x512",
      quality: "high",
      output_format: "png",
      response_format: "b64_json",
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.data.equals(PNG)).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(result.created).toBe(42);

    const calls = (context.progress as unknown as { calls: Array<{ progress: number; total?: number }> }).calls;
    expect(calls.some((call) => call.progress === 0 && call.total === 2)).toBe(true);
    expect(calls.some((call) => call.progress === 1)).toBe(true);
  });

  it("retries with a minimal body when the provider rejects an optional parameter", async () => {
    const { client, generate } = makeImagesClient();
    generate.mockRejectedValueOnce(Object.assign(new Error("unknown parameter: style"), { status: 400 }));
    generate.mockResolvedValueOnce({ created: 1, data: [{ b64_json: PNG.toString("base64") }] });
    const backend = new OpenAIImagesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 1, size: "512x512" }, makeContext());

    expect(generate).toHaveBeenCalledTimes(2);
    const retryBody = generate.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(Object.keys(retryBody).sort()).toEqual(["model", "n", "prompt", "size"]);
    expect(retryBody["prompt"]).toContain("a cat");
    expect(result.images).toHaveLength(1);
  });

  it("downloads URL results", async () => {
    const { client, generate } = makeImagesClient();
    generate.mockResolvedValue({ created: 1, data: [{ url: "https://cdn.test/x.png" }] });
    vi.stubGlobal(
      "fetch",
      async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    );

    const backend = new OpenAIImagesBackend(client);
    const result = await backend.generate({ prompt: "a cat", n: 1 }, makeContext());

    expect(result.images[0]?.data.equals(PNG)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
  });

  it("throws PROVIDER_ERROR for an empty data array", async () => {
    const { client, generate } = makeImagesClient();
    generate.mockResolvedValue({ created: 1, data: [] });
    const backend = new OpenAIImagesBackend(client);

    await expect(backend.generate({ prompt: "a cat", n: 1 }, makeContext())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("requires OPENAI_MODEL", async () => {
    const { client } = makeImagesClient();
    const backend = new OpenAIImagesBackend(client);
    const config = testConfig({ textModel: undefined });
    await expect(backend.generate({ prompt: "a cat", n: 1 }, makeContext(config))).rejects.toMatchObject({
      code: "CONFIG_MISSING",
    });
  });
});

describe("OpenAIImagesBackend.edit", () => {
  it("uploads input images and the mask", async () => {
    const { client, edit } = makeImagesClient();
    edit.mockResolvedValue({ created: 1, data: [{ b64_json: PNG.toString("base64") }] });
    const backend = new OpenAIImagesBackend(client);

    await backend.edit(
      { prompt: "make it blue", n: 1, images: [loadedPng()], mask: loadedPng() },
      makeContext(),
    );

    const body = edit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body["image"]).toBeDefined();
    expect(body["mask"]).toBeDefined();
    expect(body["stream"]).toBe(false);
    expect(body["prompt"]).toContain("make it blue");
  });

  it("requires at least one input image", async () => {
    const { client } = makeImagesClient();
    const backend = new OpenAIImagesBackend(client);
    await expect(backend.edit({ prompt: "x", n: 1, images: [] }, makeContext())).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });
});
