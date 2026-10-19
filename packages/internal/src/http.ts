/** Minimal OpenAI-compatible HTTP client: auth, timeout, cancellation, retries with Retry-After. */

import type { Config } from "./config";
import { DtstError, httpError, toDtstError } from "./errors";
import { log } from "./log";

export interface ApiRequest {
  method?: "GET" | "POST";
  json?: unknown;
  form?: FormData;
  /** Extra request headers (e.g. Fish Audio's `model`). */
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Retries for 429 / 5xx / network errors. Default 2. */
  retries?: number;
}

export async function api<T>(config: Config, endpoint: string, request: ApiRequest = {}): Promise<T> {
  return send(config, endpoint, request, "application/json", (_body, data) => data as T);
}

export interface BinaryResponse {
  data: Buffer;
  /** Full Content-Type header, parameters included (e.g. `audio/pcm;rate=24000`). */
  contentType: string;
}

/** Like `api`, for endpoints that answer with raw bytes (e.g. `/audio/speech`); JSON bodies are treated as errors. */
export async function apiBinary(config: Config, endpoint: string, request: ApiRequest = {}): Promise<BinaryResponse> {
  return send(config, endpoint, request, "*/*", (body, data, contentType) => {
    if (data !== undefined || /json/i.test(contentType)) {
      throw new DtstError("PROVIDER", `Expected binary data, got JSON: ${errorMessage(data, body.toString("utf8"))}`);
    }
    if (body.length === 0) throw new DtstError("PROVIDER", "The provider returned an empty body.");
    return { data: body, contentType };
  });
}

/** Shared request loop: auth, timeout, cancellation, error mapping and retries. */
async function send<T>(
  config: Config,
  endpoint: string,
  request: ApiRequest,
  accept: string,
  read: (body: Buffer, data: unknown, contentType: string) => T,
): Promise<T> {
  const url = `${config.baseUrl}${endpoint}`;
  const retries = request.retries ?? 2;
  const headers: Record<string, string> = { accept, ...config.headers, ...request.headers };
  if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
  if (request.json !== undefined) headers["content-type"] = "application/json";
  const body = request.form ?? (request.json === undefined ? undefined : JSON.stringify(request.json));
  const method = request.method ?? (body === undefined ? "GET" : "POST");

  for (let attempt = 0; ; attempt += 1) {
    let error: DtstError;
    try {
      const signal = withTimeout(request.signal, config.timeoutMs);
      const response = await fetch(url, { method, headers, body, signal });
      const raw = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      const text = raw.toString("utf8");
      const data = isBinary(contentType) ? undefined : parseJson(text);
      // Some gateways (OpenRouter included) report failures inside a 200 body.
      const embedded = (data as { error?: { code?: unknown } } | undefined)?.error;
      if (response.ok && !embedded) return read(raw, data, contentType);
      const status = response.ok ? (typeof embedded?.code === "number" ? embedded.code : 502) : response.status;
      error = httpError(status, errorMessage(data, text), retryAfter(response.headers.get("retry-after")));
    } catch (caught) {
      if (request.signal?.aborted) throw new DtstError("CANCELLED", "Request cancelled.");
      error = toDtstError(caught);
    }
    if (!error.retryable || attempt >= retries) throw error;
    const delay = Math.min(error.retryAfterMs ?? 1000 * 2 ** attempt, 30_000);
    log.debug(`retrying ${method} ${endpoint} in ${delay}ms`, error.message);
    await sleep(delay, request.signal);
  }
}

/** Audio, image, video and octet-stream bodies are never parsed as JSON. */
function isBinary(contentType: string): boolean {
  return /^(audio|image|video)\/|^application\/octet-stream/i.test(contentType.trim());
}

/** Download a URL with a byte cap; `truncate` keeps the first `maxBytes` instead of failing. */
export async function download(
  url: string,
  options: { maxBytes: number; truncate?: boolean; signal?: AbortSignal | undefined; timeoutMs?: number },
): Promise<{ data: Buffer; contentType: string; truncated: boolean }> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: withTimeout(options.signal, options.timeoutMs ?? 60_000),
      redirect: "follow",
    });
  } catch (error) {
    throw toDtstError(error);
  }
  if (!response.ok) throw httpError(response.status, `GET ${url} failed`);
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of response.body ?? []) {
    const buffer = Buffer.from(chunk as Uint8Array);
    if (size + buffer.length > options.maxBytes) {
      if (!options.truncate) throw new DtstError("BAD_INPUT", `${url} is larger than ${options.maxBytes} bytes.`);
      chunks.push(buffer.subarray(0, options.maxBytes - size));
      truncated = true;
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  return { data: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "", truncated };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function errorMessage(data: unknown, raw = ""): string {
  const record = (data ?? {}) as { error?: unknown; message?: unknown; detail?: unknown };
  const nested =
    typeof record.error === "object" && record.error ? (record.error as { message?: unknown }).message : undefined;
  for (const candidate of [nested, record.error, record.message, record.detail]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return raw.trim().slice(0, 300);
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DtstError("CANCELLED", "Request cancelled."));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DtstError("CANCELLED", "Request cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
