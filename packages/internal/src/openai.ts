/**
 * OpenAI-compatible client factory.
 *
 * Works against OpenAI, Azure-compatible gateways, OpenRouter, vLLM, Ollama,
 * LiteLLM and anything else that speaks the same wire format. Clients are
 * cached per effective settings so long-lived servers reuse connections.
 *
 * The SDK's own request logging is forced off: these processes print to
 * stderr, and the SDK debug output can include request bodies.
 */

import OpenAI from "openai";
import type { ProviderConfig } from "./config";
import { logger } from "./log";

interface ClientSettings {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  headers: string;
}

const cache = new Map<string, OpenAI>();

export interface ClientOverrides {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export function createOpenAIClient(config: ProviderConfig, overrides: ClientOverrides = {}): OpenAI {
  const headers = { ...config.headers, ...overrides.headers };
  const settings: ClientSettings = {
    baseUrl: (overrides.baseUrl ?? config.baseUrl).replace(/\/+$/, ""),
    apiKey: config.apiKey || "not-needed",
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
    maxRetries: overrides.maxRetries ?? config.maxRetries,
    headers: stableKey(headers),
  };
  const key = `${settings.baseUrl}|${settings.apiKey}|${settings.timeoutMs}|${settings.maxRetries}|${settings.headers}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const client = new OpenAI({
    baseURL: settings.baseUrl,
    apiKey: settings.apiKey,
    timeout: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    defaultHeaders: headers,
    // Never enable browser mode from a server process.
    dangerouslyAllowBrowser: false,
    logLevel: "off",
  });
  cache.set(key, client);
  logger.debug("created provider client", { baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs });
  return client;
}

function stableKey(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function resetClientCache(): void {
  cache.clear();
}

/** Merge DTST_EXTRA_BODY into a request body (provider-specific knobs). */
export function withExtraBody<T extends object>(config: ProviderConfig, body: T): T {
  const extra = config.extraBody;
  if (!extra || Object.keys(extra).length === 0) return body;
  return { ...extra, ...body };
}
