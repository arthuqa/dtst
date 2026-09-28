/**
 * HTTP plumbing for non-OpenAI-shaped endpoints (OpenRouter's image API,
 * model discovery) and for downloading remote image inputs.
 *
 * The OpenAI SDK covers chat completions and the OpenAI image endpoints;
 * this module covers everything else, with retries, timeouts, cancellation
 * and byte limits.
 */

import { DtstError, type ErrorCode, isDtstError, toDtstError } from "./errors";
import { logger } from "./log";

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Max response size. Default 32 MiB. */
  maxBytes?: number;
  /** Label used in error messages. */
  label?: string;
}

export interface JsonResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  json: T;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * POST/GET JSON with retry on 408/409/429/5xx, exponential backoff with
 * jitter, and `Retry-After` support. Throws DtstError on failure.
 */
export async function requestJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<JsonResponse<T>> {
  const label = options.label ?? url;
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt, lastError);
      logger.debug("retrying request", { label, attempt, delayMs: delay });
      await sleep(delay, options.signal);
    }
    try {
      // `fetchOnce` throws on non-ok responses, so retryable statuses arrive
      // through the catch block below with their Retry-After value attached.
      return (await fetchOnce(url, { ...options, timeoutMs })) as JsonResponse<T>;
    } catch (error) {
      if (isAbort(error)) throw toDtstError(error);
      lastError = error;
      if (!isRetryable(error) || attempt >= maxRetries) break;
    }
  }
  throw toDtstError(lastError);
}

async function fetchOnce(url: string, options: RequestOptions & { timeoutMs: number }): Promise<JsonResponse> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...options.headers,
  };
  if (options.body !== undefined) headers["content-type"] ??= "application/json";

  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal,
    redirect: "follow",
  });

  const text = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const json = safeParse(text);
  if (!response.ok) throw httpError(response.status, json, text, url, response.headers);
  return { status: response.status, ok: true, headers: response.headers, json, text };
}

function httpError(status: number, json: unknown, text: string, label: string, headers?: Headers): DtstError {
  const message = extractErrorMessage(json, text) ?? text.slice(0, 300);
  const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
  return new DtstError(errorCodeForStatus(status), `${label} -> HTTP ${status}: ${message}`, {
    status,
    retryable: status === 429 || status >= 500,
    ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }),
  });
}

function errorCodeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status === 404) return "PROVIDER_UNSUPPORTED";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  return "PROVIDER_ERROR";
}

/** Only retry transport failures and explicitly retryable statuses. */
function isRetryable(error: unknown): boolean {
  return isDtstError(error) ? error.retryable : true;
}

/** `Retry-After` in either delta-seconds or HTTP-date form. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function extractErrorMessage(json: unknown, raw: string): string | undefined {
  if (typeof json === "string" && json.trim()) return json.trim().slice(0, 300);
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const candidates = [
      record["error"],
      (record["error"] as Record<string, unknown> | undefined)?.["message"],
      record["message"],
      record["detail"],
      record["error_description"],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
    }
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

function safeParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^[[{"]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DtstError("PROVIDER_ERROR", `Response too large (${declared} bytes > ${maxBytes} byte limit).`);
  }
  const array = await response.arrayBuffer();
  if (array.byteLength > maxBytes) {
    throw new DtstError("PROVIDER_ERROR", `Response too large (${array.byteLength} bytes > ${maxBytes} byte limit).`);
  }
  return Buffer.from(array).toString("utf8");
}

/** Download binary content (used for remote image inputs). */
export async function fetchBinary(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ data: Buffer; contentType?: string; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, { headers: options.headers, signal, redirect: "follow" });
  } catch (error) {
    throw toDtstError(error);
  }
  if (!response.ok) {
    throw new DtstError("PROVIDER_ERROR", `Failed to download ${url} (HTTP ${response.status}).`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DtstError("BAD_INPUT", `Remote image is too large (${declared} bytes > ${maxBytes} byte limit).`);
  }
  const array = await response.arrayBuffer();
  if (array.byteLength > maxBytes) {
    throw new DtstError("BAD_INPUT", `Remote image is too large (${array.byteLength} bytes > ${maxBytes} byte limit).`);
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    data: Buffer.from(array),
    ...(contentType === undefined ? {} : { contentType }),
    finalUrl: response.url || url,
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DtstError("CANCELLED", "Aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DtstError("CANCELLED", "Aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffDelay(attempt: number, error: unknown): number {
  const retryAfter = extractRetryAfter(error);
  if (retryAfter !== undefined) return Math.min(retryAfter, 30_000);
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return base + Math.random() * 250;
}

function extractRetryAfter(error: unknown): number | undefined {
  if (!isDtstError(error)) return undefined;
  const details = error.details as { retryAfterMs?: unknown } | undefined;
  return typeof details?.retryAfterMs === "number" ? details.retryAfterMs : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
