/**
 * Configuration from the environment (or a `.env` in the working directory).
 *
 *   OPENAI_BASE_URL     API root, default https://api.openai.com/v1
 *   OPENAI_API_KEY      bearer token (optional for localhost / LAN endpoints)
 *   OPENAI_MODEL        default text model; image fallback
 *   OPENAI_IMAGE_MODEL  default image model
 *   DTST_WORKSPACE      root for relative paths (default: client root, else cwd)
 *   DTST_IMAGE_API      auto | images | openrouter | chat
 *   DTST_TIMEOUT_MS     per-request timeout, default 300000
 */

import fs from "node:fs";
import path from "node:path";
import { DtstError } from "./errors";
import { registerSecret } from "./log";

export type ImageApi = "auto" | "images" | "openrouter" | "chat";
const IMAGE_APIS: readonly ImageApi[] = ["auto", "images", "openrouter", "chat"];

export interface Config {
  baseUrl: string;
  apiKey: string;
  textModel?: string;
  imageModel?: string;
  workspace?: string;
  imageApi: ImageApi;
  timeoutMs: number;
  /** Extra headers (OpenRouter attribution). */
  headers: Record<string, string>;
  openRouter: boolean;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Load `<cwd>/.env` without overriding variables that are already set. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env");
  if (fs.existsSync(file) && fs.statSync(file).isFile()) process.loadEnvFile(file);
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.0\.0\.0$/.test(host)
  );
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const read = (key: string): string | undefined => env[key]?.trim() || undefined;

  const rawUrl = read("OPENAI_BASE_URL") ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DtstError("CONFIG", `OPENAI_BASE_URL is not a valid URL: ${rawUrl}`, "e.g. https://openrouter.ai/api/v1");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DtstError("CONFIG", `OPENAI_BASE_URL must be http(s), got ${url.protocol}`);
  }

  const apiKey = read("OPENAI_API_KEY") ?? "";
  if (!apiKey && !isLocalHost(url.hostname)) {
    throw new DtstError(
      "CONFIG",
      "OPENAI_API_KEY is not set.",
      "Add it to this server's `env` block in the MCP client config, or to a .env file in its working directory.",
    );
  }

  const imageApi = (read("DTST_IMAGE_API")?.toLowerCase() ?? "auto") as ImageApi;
  if (!IMAGE_APIS.includes(imageApi)) {
    throw new DtstError("CONFIG", `DTST_IMAGE_API must be one of ${IMAGE_APIS.join("|")}, got "${imageApi}".`);
  }

  const timeoutMs = Number(read("DTST_TIMEOUT_MS") ?? 300_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new DtstError("CONFIG", "DTST_TIMEOUT_MS must be an integer >= 1000.");
  }

  const openRouter = url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai");
  registerSecret(apiKey);

  const config: Config = {
    baseUrl: rawUrl.replace(/\/+$/, ""),
    apiKey,
    imageApi,
    timeoutMs,
    openRouter,
    headers: openRouter ? { "X-Title": "dtst", "HTTP-Referer": "https://github.com/arthuqa/dtst" } : {},
  };
  const textModel = read("OPENAI_MODEL");
  const imageModel = read("OPENAI_IMAGE_MODEL");
  const workspace = read("DTST_WORKSPACE");
  if (textModel) config.textModel = textModel;
  if (imageModel) config.imageModel = imageModel;
  if (workspace) config.workspace = workspace;
  return config;
}
