/**
 * Test helpers for the @dtst/img unit suites.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type LoadedImage,
  type Logger,
  type ProgressReporter,
  type ProviderConfig,
} from "@dtst/internal";

export function be32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** Build a structurally valid (but not decodable) PNG with the given size. */
export function makePng(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0]), be32(0)]);
  const ihdr = Buffer.concat([Buffer.from("IHDR", "ascii"), ihdrData]);
  const idat = Buffer.concat([Buffer.from("IDAT", "ascii"), Buffer.from([1, 2, 3, 4]), be32(0)]);
  const iend = Buffer.concat([Buffer.from("IEND", "ascii"), be32(0)]);
  return Buffer.concat([signature, be32(ihdrData.length), ihdr, be32(4), idat, be32(0), iend]);
}

export function pngDataUrl(width = 1, height = 1): string {
  return `data:image/png;base64,${makePng(width, height).toString("base64")}`;
}

export function loadedPng(width = 1, height = 1): LoadedImage {
  const data = makePng(width, height);
  return {
    data,
    mimeType: "image/png",
    base64: data.toString("base64"),
    bytes: data.byteLength,
    source: "test-input",
    label: "input.png",
  };
}

export function silentLogger(): Logger {
  const log: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

export interface ProgressCall {
  progress: number;
  total?: number;
  message?: string;
}

export function recordingProgress(): ProgressReporter & { calls: ProgressCall[] } {
  const calls: ProgressCall[] = [];
  return {
    enabled: true,
    calls,
    async report(progress, total, message) {
      calls.push({ progress, ...(total === undefined ? {} : { total }), ...(message === undefined ? {} : { message }) });
    },
    async done(message) {
      calls.push({ progress: 1, ...(message === undefined ? {} : { message }) });
    },
  };
}

export function testConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    baseUrl: "https://api.test/v1",
    apiKey: "test-key-0123456789",
    imageModel: "test-image-model",
    timeoutMs: 5_000,
    maxRetries: 0,
    headers: {},
    extraBody: {},
    workspaceRoot: process.cwd(),
    allowedWriteRoots: [],
    logLevel: "silent",
    maxImageBytes: 25 * 1024 * 1024,
    maxImages: 16,
    imageBackend: "images",
    textApi: "chat",
    allowNoApiKey: true,
    envFiles: [],
    attribution: { title: "dtst" },
    ...overrides,
  };
}

export async function makeTempDir(prefix = "dtst-img-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
