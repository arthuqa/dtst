/**
 * `withImageModelHint` rewrites only the hint of model/endpoint-shaped
 * failures, because "OPENAI_MODEL is a chat model" is the most common
 * misconfiguration once images default to the shared model knob.
 */

import { describe, expect, it } from "vitest";
import { DtstError } from "@dtst/internal";
import { withImageModelHint } from "../../src/errors";

describe("withImageModelHint", () => {
  it("keeps the provider error and adds the image-model hint for 404s", () => {
    const original = new DtstError("PROVIDER_UNSUPPORTED", "No model found for \"gpt-6-luna\"", { status: 404 });
    const rewritten = withImageModelHint(original, "gpt-6-luna");
    expect(rewritten.code).toBe("PROVIDER_UNSUPPORTED");
    expect(rewritten.status).toBe(404);
    expect(rewritten.message).toBe(original.message);
    expect(rewritten.hint).toContain("gpt-6-luna");
    expect(rewritten.hint).toContain("DTST_IMAGE_MODEL");
  });

  it("handles the 'output modalities' rejection", () => {
    const original = new DtstError("PROVIDER_ERROR", "No endpoints found that support the requested output modalities: image, text", {
      status: 404,
    });
    expect(withImageModelHint(original, "openai/gpt-6-luna").hint).toContain("list_image_models");
  });

  it("never talks about models for auth, rate limit or network failures", () => {
    for (const error of [
      new DtstError("PROVIDER_AUTH", "Invalid API key", { status: 401 }),
      new DtstError("PROVIDER_RATE_LIMIT", "Too many requests", { status: 429 }),
      new DtstError("PROVIDER_TIMEOUT", "Request timed out", { status: undefined, retryable: true }),
      new DtstError("NETWORK", "fetch failed"),
    ]) {
      const rewritten = withImageModelHint(error, "some-model");
      expect(rewritten.hint).toBe(error.hint);
      expect(rewritten.code).toBe(error.code);
    }
  });

  it("leaves unrelated validation errors alone", () => {
    const original = new DtstError("PROVIDER_ERROR", "400 invalid_request_error: size must be one of 1024x1024", { status: 400 });
    const rewritten = withImageModelHint(original, "gpt-image-1");
    expect(rewritten.hint).toBeUndefined();
    expect(rewritten.message).toBe(original.message);
  });

  it("accepts a missing model name", () => {
    const rewritten = withImageModelHint(new DtstError("PROVIDER_UNSUPPORTED", "not found", { status: 404 }), undefined);
    expect(rewritten.hint).toContain("OPENAI_MODEL");
  });
});
