import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterImagesBackend } from "../../src/backends/openrouter-images";
import type { BackendContext } from "../../src/backends/types";
import { loadedPng, makePng, recordingProgress, silentLogger, testConfig, jsonResponse } from "./helpers";

const PNG = makePng();

function makeContext(): BackendContext {
  return {
    config: testConfig({
      baseUrl: "https://openrouter.ai/api/v1",
      imageBackend: "openrouter",
      apiKey: "or-secret-key",
      maxRetries: 0,
    }),
    log: silentLogger(),
    progress: recordingProgress(),
    signal: new AbortController().signal,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown> | undefined;
}

function captureFetch(handler: (call: FetchCall) => Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      init,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return { calls };
}

function imageResponse(extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    created: 1,
    data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }],
    usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11, cost: 0.0123 },
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouterImagesBackend.generate", () => {
  it("POSTs to <baseUrl>/images with a bearer token and decodes b64 + cost", async () => {
    const { calls } = captureFetch(() => imageResponse());
    const backend = new OpenRouterImagesBackend();

    const result = await backend.generate({ prompt: "a cat", n: 1, size: "1024x1024" }, makeContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer or-secret-key");

    expect(calls[0]?.body).toMatchObject({ model: "test-image-model", n: 1, size: "1024x1024" });
    expect(result.images[0]?.data.equals(PNG)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 11,
      costUsd: 0.0123,
    });
  });

  it("sends input_references for edits", async () => {
    const { calls } = captureFetch(() => imageResponse());
    const backend = new OpenRouterImagesBackend();

    await backend.edit({ prompt: "recolor", n: 1, images: [loadedPng()] }, makeContext());

    const references = calls[0]?.body?.["input_references"] as Array<{
      type: string;
      image_url: { url: string };
    }>;
    expect(Array.isArray(references)).toBe(true);
    expect(references[0]?.type).toBe("image_url");
    expect(references[0]?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("retries with {model,prompt,n} when optional parameters are rejected", async () => {
    let count = 0;
    const { calls } = captureFetch(() => {
      count += 1;
      return count === 1 ? jsonResponse({ error: { message: "unknown parameter: resolution" } }, 400) : imageResponse();
    });
    const backend = new OpenRouterImagesBackend();

    const result = await backend.generate({ prompt: "a cat", n: 2, resolution: "2K" }, makeContext());

    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1]?.body ?? {}).sort()).toEqual(["model", "n", "prompt"]);
    expect(result.images).toHaveLength(1);
  });

  it("throws when the response has no images", async () => {
    captureFetch(() => jsonResponse({ created: 1, data: [] }));
    const backend = new OpenRouterImagesBackend();
    await expect(backend.generate({ prompt: "a cat", n: 1 }, makeContext())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
});

describe("OpenRouterImagesBackend.listModels", () => {
  it("maps /images/models entries including endpointCount", async () => {
    const { calls } = captureFetch(() =>
      jsonResponse({
        data: [
          {
            id: "meta/muse-image",
            name: "Muse Image",
            description: "image model",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
            supports_streaming: true,
            endpoints: [{}, {}],
          },
        ],
      }),
    );
    const backend = new OpenRouterImagesBackend();

    const models = await backend.listModels(makeContext(), { limit: 10 });

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/images/models");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "meta/muse-image",
      name: "Muse Image",
      backend: "openrouter",
      endpointCount: 2,
      supportsStreaming: true,
      outputModalities: ["image"],
    });
  });
});
