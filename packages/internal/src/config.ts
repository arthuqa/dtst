/**
 * Configuration.
 *
 * The contract with the user is deliberately OpenAI-shaped so any compatible
 * endpoint works:
 *
 *   OPENAI_BASE_URL   e.g. https://openrouter.ai/api/v1   (required)
 *   OPENAI_API_KEY    bearer token                          (required, except for local endpoints)
 *   OPENAI_MODEL      model for text AND images             (required by each call)
 *
 * `OPENAI_MODEL` is the single model knob for both servers: @dtst/txt uses it
 * for chat, @dtst/img uses it as the default image model. When an endpoint
 * needs a different model for images (a text model and an image model cannot
 * be the same id), set `DTST_IMAGE_MODEL` — a namespaced *optional* override —
 * or pass `model` per tool call.
 *
 * Everything else is optional and namespaced under DTST_*. A `.env` file is
 * discovered from the working directory upwards (clients such as Claude
 * Desktop launch MCP servers without inheriting a shell environment).
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { configError, invalidConfig } from "./errors";
import { type LogLevel, getLogLevel, logger, normalizeLevel, registerSecret } from "./log";

export type ImageBackendKind = "auto" | "images" | "openrouter" | "chat";
export type TextApiKind = "chat" | "responses";

export interface ProviderConfig {
  /** Normalized base URL, no trailing slash, `/v1` guaranteed. */
  baseUrl: string;
  apiKey: string;
  /** Default text model (`OPENAI_MODEL`). */
  textModel?: string;
  /** Optional image-model override (`DTST_IMAGE_MODEL`); falls back to `textModel`. */
  imageModel?: string;
  timeoutMs: number;
  maxRetries: number;
  /** Extra headers sent with every request. */
  headers: Record<string, string>;
  /** Provider-specific body fields merged into every request. */
  extraBody: Record<string, unknown>;
  workspaceRoot: string;
  outputDir?: string;
  allowedWriteRoots: string[];
  logLevel: LogLevel;
  maxImageBytes: number;
  maxImages: number;
  /** `@dtst/img` backend strategy. */
  imageBackend: ImageBackendKind;
  /** `@dtst/txt` API surface. */
  textApi: TextApiKind;
  allowNoApiKey: boolean;
  envFiles: string[];
  /** Attribution headers for OpenRouter-hosted endpoints. */
  attribution: { referer?: string; title: string };
}

export interface ResolveOptions {
  env: Record<string, string | undefined>;
  cwd?: string;
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  /** Pre-loaded .env files, for observability. */
  envFiles?: string[];
}

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES = 16;

function readString(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readInt(
  env: Record<string, string | undefined>,
  key: string,
  options: { min: number; max?: number },
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalidConfig(`${key} must be an integer, got ${JSON.stringify(raw)}.`);
  }
  if (value < options.min) throw invalidConfig(`${key} must be >= ${options.min}, got ${value}.`);
  if (options.max !== undefined && value > options.max) {
    throw invalidConfig(`${key} must be <= ${options.max}, got ${value}.`);
  }
  return value;
}

function readBool(env: Record<string, string | undefined>, key: string): boolean | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw invalidConfig(`${key} must be a boolean (true/false), got ${JSON.stringify(raw)}.`);
}

function readJson(env: Record<string, string | undefined>, key: string): Record<string, unknown> | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw invalidConfig(`${key} must be a JSON object: ${(error as Error).message}`);
  }
}

const KNOWN_SUFFIXES = ["/chat/completions", "/completions", "/responses", "/images/generations", "/images/edits", "/images"];

/** Normalize a user-supplied base URL so it works with the OpenAI SDK. */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  const lower = value.toLowerCase();

  for (const suffix of KNOWN_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      value = value.slice(0, -suffix.length).replace(/\/+$/, "");
      logger.warn("stripped endpoint suffix from OPENAI_BASE_URL; pass the API root instead", { suffix });
      break;
    }
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig(`OPENAI_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`, "Example: https://openrouter.ai/api/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig(`OPENAI_BASE_URL must use http or https, got ${url.protocol}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const hasVersion = segments.some((segment) => /^v\d+$/.test(segment));
  if (!hasVersion) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/+$/, "");
}

export function isLocalHost(host: string): boolean {
  const name = host.split(":")[0]?.toLowerCase() ?? "";
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name === "0.0.0.0" ||
    name.endsWith(".local") ||
    name.endsWith(".localhost") ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

/** Pure config resolution: no process.env access, no .env discovery. */
export function resolveConfig(options: ResolveOptions): ProviderConfig {
  const { env } = options;
  const cwd = options.cwd ?? process.cwd();

  const rawBaseUrl = readString(env, "OPENAI_BASE_URL", "OPENAI_API_BASE", "DTST_BASE_URL", "OPENAI_URL");
  if (!rawBaseUrl) {
    throw configError(
      "OPENAI_BASE_URL is not set.",
      "Set OPENAI_BASE_URL (e.g. https://openrouter.ai/api/v1) in the environment or in a .env file next to your project. Run the CLI with --help for a full list of variables.",
    );
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  const host = new URL(baseUrl).host;
  const local = isLocalHost(host);

  const apiKey = readString(env, "OPENAI_API_KEY", "DTST_API_KEY", "OPENAI_KEY") ?? "";
  const allowNoApiKey = readBool(env, "DTST_ALLOW_NO_API_KEY") ?? local;
  if (!apiKey && !allowNoApiKey) {
    throw configError(
      "OPENAI_API_KEY is not set.",
      "Set OPENAI_API_KEY in the environment or in a .env file. For local endpoints that ignore auth, set DTST_ALLOW_NO_API_KEY=1.",
    );
  }

  const attributes = readString(env, "DTST_EXTRA_HEADERS");
  if (attributes) {
    // Parse through readJson for a consistent error message.
    readJson(env, "DTST_EXTRA_HEADERS");
  }

  const headers: Record<string, string> = {
    ...(readJson(env, "DTST_EXTRA_HEADERS") as Record<string, string> | undefined),
  };
  const referer = readString(env, "DTST_HTTP_REFERER", "HTTP_REFERER");
  const title = readString(env, "DTST_APP_TITLE", "DTST_TITLE", "X_TITLE") ?? "dtst";
  if (host.endsWith("openrouter.ai")) {
    headers["X-Title"] ??= title;
    if (referer) headers["HTTP-Referer"] ??= referer;
  }

  const rawBackend = readString(env, "DTST_IMG_BACKEND")?.toLowerCase();
  if (rawBackend && !["auto", "images", "openrouter", "chat"].includes(rawBackend)) {
    throw invalidConfig(`DTST_IMG_BACKEND must be one of auto|images|openrouter|chat, got ${JSON.stringify(rawBackend)}.`);
  }

  const rawTextApi = readString(env, "DTST_TXT_API")?.toLowerCase();
  if (rawTextApi && !["chat", "responses"].includes(rawTextApi)) {
    throw invalidConfig(`DTST_TXT_API must be one of chat|responses, got ${JSON.stringify(rawTextApi)}.`);
  }

  const allowedRoots = (readString(env, "DTST_ALLOWED_WRITE_ROOTS") ?? "")
    .split(/[:;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const config: ProviderConfig = {
    baseUrl,
    apiKey,
    timeoutMs: readInt(env, "DTST_TIMEOUT_MS", { min: 1_000 }) ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: readInt(env, "DTST_MAX_RETRIES", { min: 0, max: 10 }) ?? options.defaultMaxRetries ?? DEFAULT_MAX_RETRIES,
    headers,
    extraBody: readJson(env, "DTST_EXTRA_BODY") ?? {},
    workspaceRoot: path.resolve(readString(env, "DTST_WORKSPACE") ?? cwd),
    allowedWriteRoots: allowedRoots.map((entry) => path.resolve(entry)),
    logLevel: normalizeLevel(readString(env, "DTST_LOG_LEVEL") ?? getLogLevel()),
    maxImageBytes: readInt(env, "DTST_MAX_IMAGE_BYTES", { min: 1024 }) ?? DEFAULT_MAX_IMAGE_BYTES,
    maxImages: readInt(env, "DTST_MAX_IMAGES", { min: 1, max: 64 }) ?? DEFAULT_MAX_IMAGES,
    imageBackend: (rawBackend as ImageBackendKind | undefined) ?? "auto",
    textApi: (rawTextApi as TextApiKind | undefined) ?? "chat",
    allowNoApiKey,
    envFiles: options.envFiles ?? [],
    attribution: { title, ...(referer === undefined ? {} : { referer }) },
  };

  const textModel = readString(env, "OPENAI_MODEL", "DTST_MODEL");
  if (textModel) config.textModel = textModel;
  // Optional: only needed when images come from a different model than text.
  const imageModel = readString(env, "DTST_IMAGE_MODEL", "DTST_IMAGE_MODEL_ID");
  if (imageModel) config.imageModel = imageModel;
  const outputDir = readString(env, "DTST_OUTPUT_DIR");
  if (outputDir) config.outputDir = outputDir;

  registerSecret(config.apiKey);
  return config;
}

/**
 * Discover and load `.env` files (explicit path, then `.env`/`.env.local`
 * walking up from the working directory). Existing `process.env` values win.
 */
export function loadEnvFiles(cwd = process.cwd(), explicitPath?: string): string[] {
  const loaded: string[] = [];
  const candidates: string[] = [];

  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw invalidConfig(`DTST_ENV_FILE points at a missing file: ${resolved}`);
    }
    candidates.push(resolved);
  } else {
    let directory = path.resolve(cwd);
    for (let depth = 0; depth < 12; depth += 1) {
      for (const name of [".env.local", ".env"]) {
        const candidate = path.join(directory, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) candidates.push(candidate);
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  for (const candidate of candidates) {
    const result = dotenv.config({ path: candidate, override: false, quiet: true });
    if (!result.error) loaded.push(candidate);
  }
  return loaded;
}

let cached: ProviderConfig | undefined;

export function loadConfig(cwd = process.cwd()): ProviderConfig {
  if (cached) return cached;
  const explicit = process.env["DTST_ENV_FILE"];
  const envFiles = loadEnvFiles(cwd, explicit);
  cached = resolveConfig({
    env: process.env,
    cwd,
    defaultTimeoutMs: Number(process.env["DTST_TIMEOUT_MS"] ?? "") || undefined,
  });
  cached.envFiles = envFiles;
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

/** Redacted, JSON-safe view of the effective configuration. */
export function configSummary(config: ProviderConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ? "set" : config.allowNoApiKey ? "not required for this endpoint" : "missing",
    textModel: config.textModel ?? null,
    imageModel: config.imageModel ?? config.textModel ?? null,
    textApi: config.textApi,
    imageBackend: config.imageBackend,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxImageBytes: config.maxImageBytes,
    maxImages: config.maxImages,
    workspaceRoot: config.workspaceRoot,
    outputDir: config.outputDir ?? null,
    allowedWriteRoots: config.allowedWriteRoots,
    headerNames: Object.keys(config.headers).sort(),
    extraBodyKeys: Object.keys(config.extraBody).sort(),
    envFiles: config.envFiles,
    logLevel: config.logLevel,
  };
}

/** Convenience: the options object consumed by the path helpers. */
export function pathOptions(config: ProviderConfig): { root: string; allowedWriteRoots: string[] } {
  return {
    root: config.outputDir ? path.resolve(config.workspaceRoot, config.outputDir) : config.workspaceRoot,
    allowedWriteRoots: config.allowedWriteRoots,
  };
}
