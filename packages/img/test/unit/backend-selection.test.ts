import { describe, expect, it } from "vitest";
import { DtstError } from "@dtst/internal";
import { isEndpointUnsupported, isOpenRouter, resolveBackend } from "../../src/backends/select";
import { silentLogger, testConfig } from "./helpers";

describe("isEndpointUnsupported", () => {
  it("is true for a 404", () => {
    expect(isEndpointUnsupported(new DtstError("PROVIDER_ERROR", "missing", { status: 404 }))).toBe(true);
  });

  it("is true for a 400 that names an unknown endpoint", () => {
    expect(isEndpointUnsupported(new DtstError("PROVIDER_ERROR", "unknown endpoint", { status: 400 }))).toBe(true);
    expect(isEndpointUnsupported(new DtstError("PROVIDER_ERROR", "unknown route /images", { status: 422 }))).toBe(true);
  });

  it("is true for the OpenRouter cross-endpoint message", () => {
    const message =
      "meta/muse-image is an image generation model and cannot be used with the chat/completions endpoint. Use the /api/v1/images endpoint instead.";
    expect(isEndpointUnsupported(new DtstError("PROVIDER_ERROR", message, { status: 400 }))).toBe(true);
  });

  it("is true for PROVIDER_UNSUPPORTED regardless of status", () => {
    expect(isEndpointUnsupported(new DtstError("PROVIDER_UNSUPPORTED", "nope"))).toBe(true);
  });

  it("is false for auth, rate-limit and generic validation errors", () => {
    expect(isEndpointUnsupported(new DtstError("PROVIDER_AUTH", "unauthorized", { status: 401 }))).toBe(false);
    expect(isEndpointUnsupported(new DtstError("PROVIDER_AUTH", "forbidden", { status: 403 }))).toBe(false);
    expect(isEndpointUnsupported(new DtstError("PROVIDER_RATE_LIMIT", "slow down", { status: 429 }))).toBe(false);
    expect(isEndpointUnsupported(new DtstError("PROVIDER_ERROR", "invalid prompt", { status: 400 }))).toBe(false);
  });

  it("is false for non-Dtst errors", () => {
    expect(isEndpointUnsupported(new Error("unknown endpoint"))).toBe(false);
  });
});

describe("resolveBackend", () => {
  const log = silentLogger();

  it("picks openrouter for an openrouter.ai host in auto mode", async () => {
    const config = testConfig({ baseUrl: "https://openrouter.ai/api/v1", imageBackend: "auto" });
    expect(isOpenRouter(config)).toBe(true);
    const selection = await resolveBackend(config, { log });
    expect(selection.backend.kind).toBe("openrouter");
  });

  it("picks images for a plain host in auto mode", async () => {
    const config = testConfig({ baseUrl: "https://api.test/v1", imageBackend: "auto" });
    expect(isOpenRouter(config)).toBe(false);
    const selection = await resolveBackend(config, { log });
    expect(selection.backend.kind).toBe("images");
  });

  it.each([
    ["images", "images"],
    ["chat", "chat"],
    ["openrouter", "openrouter"],
  ] as const)("honours DTST_IMG_BACKEND=%s", async (override, kind) => {
    const config = testConfig({ baseUrl: "https://api.test/v1", imageBackend: override });
    const selection = await resolveBackend(config, { log });
    expect(selection.backend.kind).toBe(kind);
    expect(selection.reason).toContain("DTST_IMG_BACKEND");
  });
});
