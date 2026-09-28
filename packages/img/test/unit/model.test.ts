/**
 * Model resolution: `model` on the call, else `OPENAI_MODEL`.
 *
 * One knob for both servers — an MCP client gives each server its own env
 * block, so `img` can point at an image model while `txt` points at a text
 * model without any image-specific variable.
 */

import { describe, expect, it } from "vitest";
import { describeDefaultModel, resolveImageModel } from "../../src/model";
import { testConfig } from "./helpers";

describe("resolveImageModel", () => {
  it("prefers the model passed on the call", () => {
    const config = testConfig({ textModel: "image-model" });
    expect(resolveImageModel(config, "per-call-model")).toBe("per-call-model");
  });

  it("falls back to OPENAI_MODEL", () => {
    expect(resolveImageModel(testConfig({ textModel: "meta/muse-image" }))).toBe("meta/muse-image");
  });

  it("throws CONFIG_MISSING when OPENAI_MODEL is not set", () => {
    const config = testConfig({ textModel: undefined });
    expect(() => resolveImageModel(config)).toThrowError(expect.objectContaining({ code: "CONFIG_MISSING" }));
  });

  it("ignores blank values instead of passing them to the provider", () => {
    const config = testConfig({ textModel: "meta/muse-image" });
    expect(resolveImageModel(config, "   ")).toBe("meta/muse-image");
  });

  it("reports the missing variable in the error hint", () => {
    try {
      resolveImageModel(testConfig({ textModel: undefined }));
      throw new Error("expected resolveImageModel to throw");
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain("OPENAI_MODEL");
    }
  });
});

describe("describeDefaultModel", () => {
  it("names OPENAI_MODEL as the source", () => {
    expect(describeDefaultModel(testConfig({ textModel: "meta/muse-image" }))).toBe("meta/muse-image (OPENAI_MODEL)");
  });

  it("explains what to do when nothing is configured", () => {
    expect(describeDefaultModel(testConfig({ textModel: undefined }))).toContain("OPENAI_MODEL");
  });
});
