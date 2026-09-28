/**
 * Provider-agnostic completion layer.
 *
 * Two API surfaces exist behind "OpenAI-compatible":
 *
 *   - `/chat/completions` (universal: OpenAI, OpenRouter, vLLM, Ollama, LiteLLM)
 *   - `/responses`        (OpenAI's current primary API; also vLLM/Ollama)
 *
 * `DTST_TXT_API` selects one (default `chat` for maximum compatibility), and
 * an automatic downgrade to chat happens when a provider rejects `/responses`.
 * Streaming is opt-in and reported through MCP progress notifications.
 */

import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  DtstError,
  type Logger,
  type ProgressReporter,
  type ProviderConfig,
  toChatImagePart,
  type LoadedImage,
} from "@dtst/internal";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  reasoningEffort?: string;
  jsonMode?: boolean;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  text: string;
  images?: readonly LoadedImage[];
}

export interface CompletionResult {
  text: string;
  model: string;
  usage?: Usage;
  finishReason?: string;
  reasoning?: string;
}

export interface CompletionContext {
  config: ProviderConfig;
  log: Logger;
  progress: ProgressReporter;
  signal: AbortSignal;
  stream: boolean;
}

export interface CompletionClient {
  readonly api: "chat" | "responses";
  complete(request: CompletionRequest, context: CompletionContext): Promise<CompletionResult>;
}

export function createCompletionClient(config: ProviderConfig, client: OpenAI): CompletionClient {
  if (config.textApi === "responses") return new ResponsesClient(client);
  return new ChatCompletionsClient(client);
}

export class ChatCompletionsClient implements CompletionClient {
  readonly api = "chat" as const;

  constructor(private readonly client: OpenAI) {}

  async complete(request: CompletionRequest, context: CompletionContext): Promise<CompletionResult> {
    const messages = toChatMessages(request.messages);
    const body = buildChatBody(request, messages);

    if (!context.stream) {
      return bufferedResult(await this.buffered(body, context.signal), request);
    }

    const streamingBody = { ...body, stream: true, stream_options: { include_usage: true } };
    try {
      return await this.stream(streamingBody, request, context);
    } catch (error) {
      if (!isUnsupportedParameter(error) && !isUnsupportedParameter(error, "stream")) throw error;
      context.log.warn("provider rejected stream_options; retrying without usage reporting", {
        model: request.model,
      });
      try {
        const { stream_options: _ignored, ...withoutUsage } = streamingBody;
        return await this.stream(withoutUsage, request, context);
      } catch {
        context.log.warn("provider rejected streaming; falling back to a buffered request", {
          model: request.model,
        });
        return bufferedResult(await this.buffered(body, context.signal), request);
      }
    }
  }

  /** Buffered chat completion; the body is built dynamically, hence the cast. */
  private async buffered(body: Record<string, unknown>, signal: AbortSignal): Promise<ChatCompletion> {
    return (await this.client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
      signal,
    })) as ChatCompletion;
  }

  private async stream(
    body: Record<string, unknown>,
    request: CompletionRequest,
    context: CompletionContext,
  ): Promise<CompletionResult> {
    const stream = (await this.client.chat.completions.create(body as unknown as ChatCompletionCreateParamsStreaming, {
      signal: context.signal,
    })) as unknown as AsyncIterable<{
      model?: string;
      choices?: Array<{
        delta?: { content?: string | null; reasoning?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: unknown;
    }>;
    let text = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let model = request.model;
    let chunks = 0;

    for await (const chunk of stream) {
      model = chunk.model ?? model;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) text += delta;
      const thought = choice?.delta?.reasoning;
      if (thought) reasoning += thought;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = mapUsage(chunk.usage);
      chunks += 1;
      if (chunks % 24 === 0) {
        await context.progress.report(text.length, undefined, `${text.length} chars streaming`);
      }
    }
    if (!text.trim()) {
      throw new DtstError("PROVIDER_ERROR", "The model returned an empty response.", {
        hint: "Retry, or lower `temperature`; some reasoning models need a larger `max_tokens`.",
      });
    }
    return {
      text,
      model,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(reasoning ? { reasoning } : {}),
    };
  }
}

function buildChatBody(request: CompletionRequest, messages: ChatCompletionMessageParam[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
  };
  if (request.maxTokens !== undefined) body["max_completion_tokens"] = request.maxTokens;
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.topP !== undefined) body["top_p"] = request.topP;
  if (request.stop && request.stop.length > 0) body["stop"] = request.stop;
  if (request.reasoningEffort) body["reasoning_effort"] = request.reasoningEffort;
  if (request.jsonMode) body["response_format"] = { type: "json_object" };
  return body;
}

/**
 * Shape a buffered response, refusing empty content the same way the
 * streaming path does: an empty reply is a failure, not a result.
 */
function bufferedResult(response: ChatCompletion, request: CompletionRequest): CompletionResult {
  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text.trim()) {
    throw new DtstError("PROVIDER_ERROR", "The model returned an empty response.", {
      hint: "Retry, or raise `max_tokens`; reasoning models spend the budget on hidden reasoning first.",
    });
  }
  return {
    text,
    model: response.model ?? request.model,
    ...(choice?.finish_reason === undefined || choice.finish_reason === null
      ? {}
      : { finishReason: choice.finish_reason }),
    ...(mapUsage(response.usage) === undefined ? {} : { usage: mapUsage(response.usage) }),
  };
}

export class ResponsesClient implements CompletionClient {
  readonly api = "responses" as const;

  constructor(private readonly client: OpenAI) {}

  async complete(request: CompletionRequest, context: CompletionContext): Promise<CompletionResult> {
    const input = toResponsesInput(request.messages);
    const body: Record<string, unknown> = { model: request.model, input };
    if (request.maxTokens !== undefined) body["max_output_tokens"] = request.maxTokens;
    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.reasoningEffort) body["reasoning"] = { effort: request.reasoningEffort };
    if (request.jsonMode) body["text"] = { format: { type: "json_object" } };

    const response = (await this.client.responses.create(body as never, {
      signal: context.signal,
    })) as unknown as {
      model?: string;
      output_text?: string;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };

    const text = response.output_text ?? extractResponseText(response);
    if (!text.trim()) {
      throw new DtstError("PROVIDER_ERROR", "The model returned an empty response.", {
        hint: "Verify that DTST_TXT_API=responses is supported by this endpoint, or set DTST_TXT_API=chat.",
      });
    }
    return {
      text,
      model: response.model ?? request.model,
      ...(response.usage?.input_tokens === undefined && response.usage?.output_tokens === undefined
        ? {}
        : {
            usage: {
              ...(response.usage?.input_tokens === undefined ? {} : { inputTokens: response.usage.input_tokens }),
              ...(response.usage?.output_tokens === undefined ? {} : { outputTokens: response.usage.output_tokens }),
              ...(response.usage?.total_tokens === undefined ? {} : { totalTokens: response.usage.total_tokens }),
            },
          }),
    };
  }
}

function extractResponseText(response: {
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
}): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.length > 0) parts.push(content.text);
    }
  }
  return parts.join("");
}

export function toChatMessages(messages: readonly ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (!message.images || message.images.length === 0) {
      return { role: message.role, content: message.text } as ChatCompletionMessageParam;
    }
    const parts: Array<Record<string, unknown>> = message.images.map((image) => ({ ...toChatImagePart(image) }));
    parts.push({ type: "text", text: message.text });
    return { role: message.role, content: parts } as unknown as ChatCompletionMessageParam;
  });
}

function toResponsesInput(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    const content: Array<Record<string, unknown>> = [];
    for (const image of message.images ?? []) {
      content.push({ type: "input_image", detail: "auto", image_url: toChatImagePart(image).image_url.url });
    }
    content.push({ type: "input_text", text: message.text });
    return { role: message.role === "system" ? "developer" : message.role, content };
  });
}

export function mapUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const mapped: Usage = {};
  const input = record["input_tokens"] ?? record["prompt_tokens"];
  const output = record["output_tokens"] ?? record["completion_tokens"];
  const total = record["total_tokens"];
  const cost = record["cost"];
  if (typeof input === "number") mapped.inputTokens = input;
  if (typeof output === "number") mapped.outputTokens = output;
  if (typeof total === "number") mapped.totalTokens = total;
  if (typeof cost === "number") mapped.costUsd = cost;
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function isUnsupportedParameter(error: unknown, keyword?: string): boolean {
  const candidate = error as { status?: number; message?: string } | undefined;
  const status = candidate?.status;
  if (status !== undefined && status !== 400 && status !== 422) return false;
  const message = (candidate?.message ?? String(error)).toLowerCase();
  const patterns = keyword
    ? [keyword.toLowerCase()]
    : ["stream_options", "stream", "unsupported", "unknown parameter", "unknown field", "not supported"];
  return patterns.some((pattern) => message.includes(pattern));
}
