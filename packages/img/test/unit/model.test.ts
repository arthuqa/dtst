/**
 * Image-model resolution: `model` > `DTST_IMAGE_MODEL` > `OPENAI_MODEL`.
 *
 * The last step matters most: the documented trio
 * (OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL) must be enough on its own.
 */

import { describe, expect, it } from "vitest";
import { describeDefaultModel, resolveImageModel } from "../../src/model";
import { testConfig } from "./helpers";

describe("resolveImageModel", () => {
  it("prefers the model passed on the call", () => {
    const config = testConfig({ imageModel: "override-model", textModel: "shared-model" });
    expect(resolveImageModel(config, "per-call-model")).toBe("per-call-model");
  });

  it("prefers DTST_IMAGE_MODEL over the shared OPENAI_MODEL", () => {
    const config = testConfig({ imageModel: "override-model", textModel: "shared-model" });
    expect(resolveImageModel(config)).toBe("override-model");
  });

  it("falls back to OPENAI_MODEL when no image override is configured", () => {
    const config = testConfig({ imageModel: undefined, textModel: "shared-model" });
    expect(resolveImageModel(config)).toBe("shared-model");
  });

  it("throws CONFIG_MISSING when no model is configured at all", () => {
    const config = testConfig({ imageModel: undefined, textModel: undefined });
    expect(() => resolveImageModel(config)).toThrowError(
      expect.objectContaining({ code: "CONFIG_MISSING" }),
    );
  });

  it("ignores blank values instead of passing them to the provider", () => {
    const config = testConfig({ imageModel: "   ", textModel: "shared-model" });
    expect(resolveImageModel(config, "  ")).toBe("shared-model");
  });
});

describe("describeDefaultModel", () => {
  it("names the source of the default", () => {
    expect(describeDefaultModel(testConfig({ imageModel: "img", textModel: "text" }))).toContain("DTST_IMAGE_MODEL");
    expect(describeDefaultModel(testConfig({ imageModel: undefined, textModel: "text" }))).toContain("OPENAI_MODEL");
    expect(describeDefaultModel(testConfig({ imageModel: undefined, textModel: undefined }))).toContain("OPENAI_MODEL");
  });
});
