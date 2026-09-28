import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { ChatModalitiesBackend } from "../../src/backends/chat-modalities";
import type { BackendContext } from "../../src/backends/types";
import { loadedPng, makePng, pngDataUrl, recordingProgress, silentLogger, testConfig } from "./helpers";

const PNG = makePng();
const DATA_URL = pngDataUrl();

function makeChatClient(): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  const client = { chat: { completions: { create } }, models: { list: vi.fn() } } as unknown as OpenAI;
  return { client, create };
}

function imageResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    created: 5,
    choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }],
    ...overrides,
  };
}

function makeContext(): BackendContext {
  return {
    config: testConfig(),
    log: silentLogger(),
    progress: recordingProgress(),
    signal: new AbortController().signal,
  };
}

describe("ChatModalitiesBackend.generate", () => {
  it("extracts an image from the structured images array", async () => {
    const { client, create } = makeChatClient();
    create.mockResolvedValue(imageResponse({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
    const backend = new ChatModalitiesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 1 }, makeContext());

    expect(result.images[0]?.data.equals(PNG)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body["modalities"]).toEqual(["image", "text"]);
    expect(body["model"]).toBe("test-image-model");
  });

  it("emits n sequential calls and merges usage", async () => {
    const { client, create } = makeChatClient();
    create
      .mockResolvedValueOnce(imageResponse({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      .mockResolvedValueOnce(imageResponse({ usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    const backend = new ChatModalitiesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 2 }, makeContext());

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    expect(result.notes).toContain("sequential");
  });

  it("keeps the first image and adds a note when the second call fails", async () => {
    const { client, create } = makeChatClient();
    create.mockResolvedValueOnce(imageResponse()).mockRejectedValueOnce(new Error("provider down"));
    const backend = new ChatModalitiesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 2 }, makeContext());

    expect(result.images).toHaveLength(1);
    expect(result.notes).toContain("Only 1 of 2 requested images were produced");
  });

  it("throws PROVIDER_ERROR when the model returns only text", async () => {
    const { client, create } = makeChatClient();
    create.mockResolvedValue({ created: 1, choices: [{ message: { content: "I cannot draw that." } }] });
    const backend = new ChatModalitiesBackend(client);

    await expect(backend.generate({ prompt: "a cat", n: 1 }, makeContext())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("extracts a data URL embedded in the text content", async () => {
    const { client, create } = makeChatClient();
    create.mockResolvedValue({
      created: 1,
      choices: [{ message: { content: `Here you go: ${DATA_URL}` } }],
    });
    const backend = new ChatModalitiesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 1 }, makeContext());
    expect(result.images[0]?.data.equals(PNG)).toBe(true);
    expect(result.notes).toContain("Model note:");
  });

  it("retries once with a minimal body when modalities are rejected", async () => {
    const { client, create } = makeChatClient();
    create
      .mockRejectedValueOnce(Object.assign(new Error("unknown parameter: modalities"), { status: 400 }))
      .mockResolvedValueOnce(imageResponse());
    const backend = new ChatModalitiesBackend(client);

    const result = await backend.generate({ prompt: "a cat", n: 1, size: "1024x1024" }, makeContext());

    expect(create).toHaveBeenCalledTimes(2);
    const retryBody = create.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retryBody["image_config"]).toBeUndefined();
    expect(retryBody["modalities"]).toEqual(["image"]);
    expect(Object.keys(retryBody).sort()).toEqual(["messages", "modalities", "model"]);
    expect(result.images).toHaveLength(1);
  });
});

describe("ChatModalitiesBackend.edit", () => {
  it("puts input images before the text part", async () => {
    const { client, create } = makeChatClient();
    create.mockResolvedValue(imageResponse());
    const backend = new ChatModalitiesBackend(client);

    await backend.edit({ prompt: "make it blue", n: 1, images: [loadedPng()] }, makeContext());

    const body = create.mock.calls[0]?.[0] as { messages: Array<{ content: Array<{ type: string }> }> };
    const content = body.messages[0]?.content ?? [];
    expect(content[0]?.type).toBe("image_url");
    expect(content[content.length - 1]?.type).toBe("text");
  });

  it("throws BAD_INPUT with no input images", async () => {
    const { client } = makeChatClient();
    const backend = new ChatModalitiesBackend(client);
    await expect(backend.edit({ prompt: "x", n: 1, images: [] }, makeContext())).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });
});
