/**
 * Shared, network-free test helpers for the @dtst/txt unit suite.
 *
 * Everything here builds objects by hand or stubs global `fetch`, so no test
 * ever talks to a provider.
 */

import { vi } from "vitest";
import {
  ArtifactStore,
  setLogLevel,
  resetClientCache,
  type LoadedImage,
  type Logger,
  type ProgressReporter,
  type ProviderConfig,
} from "@dtst/internal";
import type { OperationContext } from "../../src/operations";

// Keep every logger quiet: some code paths warn/debug during the tests.
setLogLevel("silent");

/** A real, valid 1x1 PNG (magic bytes + IHDR dimensions). */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, "base64");

export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/** A hand-built config; never loaded from the environment and never networked. */
export function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "sk-test-1234567890",
    textModel: "test-model",
    timeoutMs: 5_000,
    maxRetries: 0,
    headers: {},
    extraBody: {},
    workspaceRoot: process.cwd(),
    allowedWriteRoots: [],
    logLevel: "silent",
    maxImageBytes: 25 * 1024 * 1024,
    maxImages: 16,
    imageBackend: "auto",
    textApi: "chat",
    allowNoApiKey: false,
    envFiles: [],
    attribution: { title: "dtst" },
    ...overrides,
  };
}

export interface ProgressCall {
  progress: number;
  total: number | undefined;
  message: string | undefined;
}

/** An OperationContext with a ProgressReporter that records every call. */
export function makeOperationContext(
  config: ProviderConfig,
  overrides: Partial<OperationContext> = {},
): { context: OperationContext; progressCalls: ProgressCall[] } {
  const progressCalls: ProgressCall[] = [];
  const progress: ProgressReporter = {
    enabled: true,
    async report(progress, total, message) {
      progressCalls.push({ progress, total, message });
    },
    async done() {},
  };
  const context: OperationContext = {
    config,
    log: silentLogger,
    progress,
    signal: new AbortController().signal,
    artifacts: new ArtifactStore(),
    ...overrides,
  };
  return { context, progressCalls };
}

/** A `LoadedImage` for image-part assertions. */
export function makeLoadedImage(overrides: Partial<LoadedImage> = {}): LoadedImage {
  const data = overrides.data ?? Buffer.from("AAAA");
  return {
    data,
    mimeType: "image/png",
    base64: data.toString("base64"),
    bytes: data.byteLength,
    source: "test.png",
    label: "test.png",
    ...overrides,
  };
}

/** A canned OpenAI Chat Completions response body. */
export function chatCompletion(
  text: string,
  options: { usage?: Record<string, number>; model?: string } = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: options.model ?? "test-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: options.usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface CapturedRequest {
  url: string;
  body: unknown;
}

export type FetchHandler = (url: string, body: unknown) => Response | Promise<Response>;

export interface FetchStub {
  requests: CapturedRequest[];
  /** Change how the stub responds; safe to call between operations. */
  respond(handler: FetchHandler): void;
  callCount(): number;
}

/**
 * Install a global `fetch` stub and reset the OpenAI client cache so a fresh
 * client captures the stub (the SDK resolves global fetch at construction).
 */
export function installFetch(initial?: FetchHandler): FetchStub {
  const requests: CapturedRequest[] = [];
  let handler: FetchHandler = initial ?? (() => jsonResponse(chatCompletion("ok")));
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, body });
    return handler(url, body);
  });
  vi.stubGlobal("fetch", mock);
  resetClientCache();
  return {
    requests,
    respond: (next) => {
      handler = next;
    },
    callCount: () => mock.mock.calls.length,
  };
}

export function bodyAt(stub: FetchStub, index: number): Record<string, unknown> {
  const request = stub.requests[index];
  if (!request) throw new Error(`No request was captured at index ${index}.`);
  if (!request.body || typeof request.body !== "object") throw new Error("Captured request body is not an object.");
  return request.body as Record<string, unknown>;
}

export interface CapturedMessage {
  role: string;
  content: unknown;
}

export function messagesOf(body: Record<string, unknown>): CapturedMessage[] {
  return body["messages"] as CapturedMessage[];
}
