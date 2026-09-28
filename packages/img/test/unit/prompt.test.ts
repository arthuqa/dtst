import { describe, expect, it } from "vitest";
import { DtstError, isDtstError } from "@dtst/internal";
import { buildPrompt, composeChatPrompt, filenameFromPrompt, normalizePrompt, timestampSlug } from "../../src/prompt";

function catchBadInput(fn: () => unknown): DtstError {
  try {
    fn();
  } catch (error) {
    if (!isDtstError(error)) throw error;
    return error;
  }
  throw new Error("expected a DtstError");
}

describe("buildPrompt", () => {
  it("joins the prompt with style, negative prompt and instructions", () => {
    const prompt = buildPrompt({
      prompt: "a cat",
      style: "watercolor",
      negativePrompt: "blurry",
      instructions: "Be precise.",
    });
    expect(prompt).toBe("a cat\n\nStyle: watercolor\n\nAvoid: blurry\n\nBe precise.");
  });

  it("returns just the trimmed prompt when there are no extras", () => {
    expect(buildPrompt({ prompt: "  a cat  " })).toBe("a cat");
    expect(buildPrompt({ prompt: "a cat", style: "  ", negativePrompt: "", instructions: "  " })).toBe("a cat");
  });
});

describe("composeChatPrompt", () => {
  it("adds the no-commentary instruction", () => {
    const prompt = composeChatPrompt({ prompt: "a cat", style: "ink", negativePrompt: "blur" });
    expect(prompt).toContain("a cat");
    expect(prompt).toContain("Style: ink");
    expect(prompt).toContain("Do not include: blur");
    expect(prompt).toContain("Return the image only, without commentary.");
  });
});

describe("normalizePrompt", () => {
  it("trims a normal prompt", () => {
    expect(normalizePrompt("  a cat ")).toBe("a cat");
  });

  it("rejects whitespace-only prompts", () => {
    expect(catchBadInput(() => normalizePrompt("   ")).code).toBe("BAD_INPUT");
  });

  it("rejects prompts over 30000 characters", () => {
    expect(catchBadInput(() => normalizePrompt("x".repeat(30_001))).code).toBe("BAD_INPUT");
    expect(normalizePrompt("x".repeat(30_000))).toHaveLength(30_000);
  });
});

describe("filenameFromPrompt", () => {
  it("produces a lowercase dashed slug without stop words", () => {
    expect(filenameFromPrompt("Ultra detailed red panda astronaut")).toBe("red-panda-astronaut");
  });

  it("falls back when every word is filtered out", () => {
    expect(filenameFromPrompt("A Photo of the Image")).toBe("image");
    expect(filenameFromPrompt("!!! ???")).toBe("image");
    expect(filenameFromPrompt("a the of", "custom")).toBe("custom");
  });

  it("caps the slug length", () => {
    const slug = filenameFromPrompt("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff");
    expect(slug).toHaveLength(60);
  });
});

describe("timestampSlug", () => {
  it("formats a date deterministically", () => {
    expect(timestampSlug(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
  });
});
