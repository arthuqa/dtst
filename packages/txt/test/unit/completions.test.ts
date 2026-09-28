import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { DtstError } from "@dtst/internal";
import {
  ChatCompletionsClient,
  ResponsesClient,
  createCompletionClient,
  mapUsage,
  toChatMessages,
  type CompletionContext,
} from "../../src/api/completions";
import { makeConfig, makeLoadedImage, silentLogger } from "./helpers";

function context(stream: boolean): CompletionContext {
  return {
    config: makeConfig(),
    log: silentLogger,
    progress: { enabled: false, async report() {}, async done() {} },
    signal: new AbortController().signal,
    stream,
  };
}

function fakeChatClient(create: unknown): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function fakeResponsesClient(create: unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI;
}

describe("toChatMessages", () => {
  it("keeps a message without images as string content", () => {
    const messages = toChatMessages([{ role: "system", text: "hello" }]);
    expect(messages).toEqual([{ role: "system", content: "hello" }]);
  });

  it("turns a message with images into image parts followed by the text part", () => {
    const image = makeLoadedImage();
    const messages = toChatMessages([{ role: "user", text: "describe this", images: [image, image] }]);
    const content = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.base64}` },
    });
    expect(content[1]).toMatchObject({ type: "image_url" });
    expect(content[2]).toEqual({ type: "text", text: "describe this" });
  });
});

describe("mapUsage", () => {
  it("maps an OpenAI chat usage object", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("maps a Responses-style usage object", () => {
    expect(mapUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("maps OpenRouter's extra cost field", () => {
    expect(mapUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0012 })).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.0012,
    });
  });

  it("returns undefined for empty or missing usage", () => {
    expect(mapUsage({})).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage(undefined)).toBeUndefined();
  });
});

describe("ChatCompletionsClient", () => {
  it("buffers a completion and forwards sampling parameters", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "model-from-response",
      choices: [{ index: 0, message: { role: "assistant", content: "buffered text" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    const client = new ChatCompletionsClient(fakeChatClient(create));

    const result = await client.complete(
      { model: "m1", messages: [{ role: "user", text: "hi" }], maxTokens: 64, temperature: 0.2, jsonMode: true },
      context(false),
    );

    expect(result).toEqual({
      text: "buffered text",
      model: "model-from-response",
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });

    const [body] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body).toMatchObject({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 64,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("top_p");
  });

  it("throws PROVIDER_ERROR with a max_tokens hint when a streamed response is empty", async () => {
    async function* empty() {
      yield { model: "m", choices: [{ delta: {}, finish_reason: "stop" }] };
    }
    const create = vi.fn().mockResolvedValue(empty());
    const client = new ChatCompletionsClient(fakeChatClient(create));

    const error = await client
      .complete({ model: "m", messages: [{ role: "user", text: "hi" }] }, context(true))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DtstError);
    expect((error as DtstError).code).toBe("PROVIDER_ERROR");
    expect((error as DtstError).hint).toContain("max_tokens");
  });

  it("consumes a streamed response and records usage from the final chunk", async () => {
    async function* stream() {
      yield { model: "m2", choices: [{ delta: { content: "Hel" } }] };
      yield { model: "m2", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] };
      yield { model: "m2", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    }
    const create = vi.fn().mockResolvedValue(stream());
    const client = new ChatCompletionsClient(fakeChatClient(create));

    const result = await client.complete({ model: "m1", messages: [{ role: "user", text: "hi" }] }, context(true));

    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("m2");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });

    const [body] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("escapes to a buffered request when streaming is rejected", async () => {
    const unsupported = () => Object.assign(new Error("unsupported parameter: stream_options"), { status: 400 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(unsupported())
      .mockRejectedValueOnce(unsupported())
      .mockResolvedValueOnce({
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "fallback text" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    const client = new ChatCompletionsClient(fakeChatClient(create));

    const result = await client.complete({ model: "m1", messages: [{ role: "user", text: "hi" }] }, context(true));

    expect(result.text).toBe("fallback text");
    expect(create).toHaveBeenCalledTimes(3);
    const [firstBody] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(firstBody).toMatchObject({ stream: true });
    const [thirdBody] = create.mock.calls[2] as [Record<string, unknown>, unknown];
    expect(thirdBody).not.toHaveProperty("stream");
  });
});

describe("ResponsesClient", () => {
  it("prefers output_text and maps the request body (developer role, input_image parts)", async () => {
    const image = makeLoadedImage();
    const create = vi.fn().mockResolvedValue({
      model: "r1",
      output_text: "responses text",
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    });
    const client = new ResponsesClient(fakeResponsesClient(create));

    const result = await client.complete(
      {
        model: "m1",
        messages: [
          { role: "system", text: "sys" },
          { role: "user", text: "hi", images: [image] },
        ],
      },
      context(false),
    );

    expect(result.text).toBe("responses text");
    expect(result.model).toBe("r1");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6, totalTokens: 11 });

    const [body] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body["model"]).toBe("m1");
    const input = body["input"] as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: "developer", content: [{ type: "input_text", text: "sys" }] });
    expect(input[1]).toEqual({
      role: "user",
      content: [
        { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${image.base64}` },
        { type: "input_text", text: "hi" },
      ],
    });
  });

  it("concatenates output[].content[].text when output_text is absent", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "r2",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Hello " },
            { type: "output_text", text: "world" },
          ],
        },
      ],
    });
    const client = new ResponsesClient(fakeResponsesClient(create));

    const result = await client.complete({ model: "m1", messages: [{ role: "user", text: "hi" }] }, context(false));
    expect(result.text).toBe("Hello world");
  });

  it("throws PROVIDER_ERROR on an empty output", async () => {
    const create = vi.fn().mockResolvedValue({ model: "r", status: "completed", output: [], output_text: "" });
    const client = new ResponsesClient(fakeResponsesClient(create));

    const error = await client
      .complete({ model: "m1", messages: [{ role: "user", text: "hi" }] }, context(false))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DtstError);
    expect((error as DtstError).code).toBe("PROVIDER_ERROR");
  });

  it("maps max tokens and JSON mode onto the responses body", async () => {
    const create = vi.fn().mockResolvedValue({ model: "r", output_text: "{}" });
    const client = new ResponsesClient(fakeResponsesClient(create));

    await client.complete(
      {
        model: "m1",
        messages: [{ role: "user", text: "hi" }],
        maxTokens: 128,
        reasoningEffort: "high",
        jsonMode: true,
      },
      context(false),
    );

    const [body] = create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body).toMatchObject({
      max_output_tokens: 128,
      reasoning: { effort: "high" },
      text: { format: { type: "json_object" } },
    });
  });
});

describe("createCompletionClient", () => {
  it("selects the client for the configured text API", () => {
    const fake = fakeChatClient(vi.fn());
    expect(createCompletionClient(makeConfig(), fake)).toBeInstanceOf(ChatCompletionsClient);
    expect(createCompletionClient(makeConfig({ textApi: "responses" }), fake)).toBeInstanceOf(ResponsesClient);
  });
});
