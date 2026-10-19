import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeProvider,
  PNG_1x1,
  WEBP_HEADER,
  callTool,
  connect,
  fakeProvider,
  pngOfSize,
  tempDir,
  textOf,
} from "../../internal/test/helpers";
import { createServer } from "../src/server";

let provider: FakeProvider;
let root: string;

const b64 = (data: Buffer): string => data.toString("base64");
const imagesReply = (...images: Buffer[]) => ({ json: { data: images.map((image) => ({ b64_json: b64(image) })) } });

async function client(env: Record<string, string> = {}) {
  vi.stubEnv("OPENAI_BASE_URL", provider.url);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
  vi.stubEnv("OPENAI_IMAGE_MODEL", "test/image-model");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return connect(createServer(), { root });
}

beforeEach(async () => {
  provider = await fakeProvider();
  root = tempDir();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await provider.close();
});

describe("generate_image · OpenAI images API", () => {
  it("saves the image, previews it inline and returns structured paths", async () => {
    provider.on("POST /images/generations", imagesReply(pngOfSize(1024, 1536)));
    const result = await callTool(await client(), "generate_image", {
      prompt: "A red panda astronaut",
      aspect_ratio: "2:3",
    });

    expect(result.isError).toBeFalsy();
    expect(provider.requests[0]?.json).toEqual({
      model: "test/image-model",
      prompt: "A red panda astronaut",
      n: 1,
      size: "1024x1536",
    });
    const file = path.join(root, "red-panda-astronaut.png");
    expect(existsSync(file)).toBe(true);
    expect(result.structuredContent).toEqual({
      model: "test/image-model",
      images: [{ path: file, mime_type: "image/png", bytes: PNG_1x1.length, width: 1024, height: 1536 }],
    });
    expect(result.content.map((block) => block.type)).toEqual(["image", "resource_link", "text"]);
    expect(textOf(result)).toContain(file);
  });

  it("numbers batch files 1..n inside the requested folder", async () => {
    provider.on("POST /images/generations", imagesReply(PNG_1x1, PNG_1x1, PNG_1x1));
    const result = await callTool(await client(), "generate_image", { prompt: "icon", n: 3, output: "out/" });
    const paths = (result.structuredContent as { images: { path: string }[] }).images.map((image) =>
      path.relative(root, image.path),
    );
    expect(paths).toEqual(["out/icon-1.png", "out/icon-2.png", "out/icon-3.png"]);
  });

  it("infers the format from `output` and fixes a mismatched extension", async () => {
    provider.on("POST /images/generations", imagesReply(WEBP_HEADER));
    const result = await callTool(await client(), "generate_image", { prompt: "x", output: "hero.jpg" });
    expect(provider.requests[0]?.json.output_format).toBe("jpeg");
    expect((result.structuredContent as { images: { path: string }[] }).images[0]?.path).toBe(
      path.join(root, "hero.webp"),
    );
    expect(textOf(result)).toMatch(/returned image\/webp/);
  });

  it("never overwrites unless asked", async () => {
    writeFileSync(path.join(root, "a.png"), "old");
    provider.on("POST /images/generations", imagesReply(PNG_1x1));
    const c = await client();
    await callTool(c, "generate_image", { prompt: "x", output: "a.png" });
    expect(existsSync(path.join(root, "a-1.png"))).toBe(true);
    await callTool(c, "generate_image", { prompt: "x", output: "a.png", overwrite: true });
    expect(readFileSync(path.join(root, "a.png"))).toEqual(PNG_1x1);
  });

  it("asks DALL·E for base64 and retries without fields a provider rejects", async () => {
    let calls = 0;
    provider.on("POST /images/generations", () =>
      ++calls === 1
        ? { status: 400, json: { error: { message: "Unknown parameter: 'quality'" } } }
        : imagesReply(PNG_1x1),
    );
    const result = await callTool(await client(), "generate_image", { prompt: "x", model: "dall-e-3", quality: "hd" });
    expect(provider.requests[0]?.json).toMatchObject({ response_format: "b64_json", quality: "hd" });
    expect(provider.requests[1]?.json).toEqual({ model: "dall-e-3", prompt: "x", n: 1 });
    expect(textOf(result)).toMatch(/retried without: quality, response_format/);
  });

  it("edits with multipart image[] and a mask", async () => {
    writeFileSync(path.join(root, "a.png"), PNG_1x1);
    writeFileSync(path.join(root, "b.png"), PNG_1x1);
    provider.on("POST /images/edits", imagesReply(PNG_1x1));
    const result = await callTool(await client(), "edit_image", {
      prompt: "add a hat",
      images: ["*.png"],
      mask: "a.png",
    });
    expect(result.isError).toBeFalsy();
    const form = provider.requests[0]?.form;
    expect(form?.getAll("image[]")).toHaveLength(2);
    expect(form?.get("mask")).toBeInstanceOf(File);
    expect(form?.get("prompt")).toBe("add a hat");
  });
});

describe("generate_image · OpenRouter", () => {
  const openRouterEnv = () => ({ DTST_IMAGE_API: "openrouter" });

  it("sends tiers as resolution and inputs as input_references, reports cost", async () => {
    writeFileSync(path.join(root, "in.png"), PNG_1x1);
    provider.on("POST /images", { json: { data: [{ b64_json: b64(PNG_1x1) }], usage: { cost: 0.0123 } } });
    const result = await callTool(await client(openRouterEnv()), "edit_image", {
      prompt: "watercolour",
      images: ["in.png"],
      size: "2k",
      aspect_ratio: "16:9",
      seed: 7,
    });
    expect(provider.requests[0]?.json).toMatchObject({
      resolution: "2K",
      aspect_ratio: "16:9",
      seed: 7,
      input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(PNG_1x1)}` } }],
    });
    expect(provider.requests[0]?.json.size).toBeUndefined();
    expect((result.structuredContent as { cost_usd: number }).cost_usd).toBe(0.0123);
  });

  it("rejects masks before spending anything", async () => {
    writeFileSync(path.join(root, "in.png"), PNG_1x1);
    const result = await callTool(await client(openRouterEnv()), "edit_image", {
      prompt: "x",
      images: ["in.png"],
      mask: "in.png",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^BAD_INPUT: `mask`/);
    expect(provider.requests).toHaveLength(0);
  });

  it("surfaces a missing input image as an error", async () => {
    const result = await callTool(await client(openRouterEnv()), "edit_image", {
      prompt: "x",
      images: ["missing.png"],
    });
    expect(textOf(result)).toMatch(/^BAD_INPUT: Could not load image input\(s\): missing\.png/);
  });
});

describe("auto routing and chat fallback", () => {
  it("falls back to chat completions when the images route lacks the model", async () => {
    provider.on("POST /images/generations", { status: 404, json: { error: { message: "No model found" } } });
    provider.on("POST /chat/completions", {
      json: {
        choices: [
          { message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${b64(PNG_1x1)}` } }] } },
        ],
      },
    });
    const result = await callTool(await client(), "generate_image", { prompt: "x", n: 2, size: "1536x1024" });
    expect(result.isError).toBeFalsy();
    expect(provider.requests.filter((request) => request.path === "/chat/completions")).toHaveLength(2);
    expect(provider.requests[1]?.json).toMatchObject({
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "3:2" },
    });
    expect((result.structuredContent as { images: unknown[] }).images).toHaveLength(2);
  });

  it("explains when the model is a text model", async () => {
    provider.on("POST /images/generations", { status: 404, json: { error: { message: "No model found" } } });
    provider.on("POST /chat/completions", {
      status: 404,
      json: { error: { message: "No endpoints found that support the requested output modalities: image, text" } },
    });
    const result = await callTool(await client(), "generate_image", { prompt: "x", model: "some/text-model" });
    expect(textOf(result)).toMatch(
      /^UNSUPPORTED: "some\/text-model" does not generate images[\s\S]*OPENAI_IMAGE_MODEL/,
    );
  });

  it("does not hide auth or credit errors behind a fallback", async () => {
    provider.on("POST /images/generations", { status: 402, json: { error: { message: "Insufficient credits" } } });
    const result = await callTool(await client(), "generate_image", { prompt: "x" });
    expect(textOf(result)).toMatch(/^CREDITS: Insufficient credits/);
    expect(provider.requests).toHaveLength(1);
  });

  it("needs a model", async () => {
    const c = await client({ OPENAI_IMAGE_MODEL: "", OPENAI_MODEL: "" });
    expect(textOf(await callTool(c, "generate_image", { prompt: "x" }))).toMatch(/^CONFIG: No image model/);
  });
});

describe("tool metadata", () => {
  it("names the configured image model in the schema and instructions", async () => {
    const c = await client();
    const tools = (await c.listTools()).tools.filter((tool) => tool.name !== "list_image_models");
    for (const tool of tools) {
      expect((tool.inputSchema.properties!["model"] as { description: string }).description).toMatch(
        /^Omit to use the configured model \(test\/image-model\)/,
      );
    }
    expect(c.getInstructions()).toContain("Configured model: test/image-model.");
  });
});

describe("list_image_models", () => {
  it("merges OpenRouter's images and chat lists with parameter summaries", async () => {
    provider.on("GET /images/models", {
      json: {
        data: [
          {
            id: "openai/gpt-image-2",
            name: "GPT Image 2",
            endpoints: "/api/v1/images/models/openai/gpt-image-2/endpoints",
            supported_parameters: {
              quality: { type: "enum", values: ["low", "high"] },
              n: { type: "range", min: 1, max: 10 },
            },
          },
        ],
      },
    });
    provider.on("GET /models", {
      json: { data: [{ id: "openai/gpt-image-2" }, { id: "google/chat-image" }, { id: "openrouter/auto" }] },
    });
    const result = await callTool(await client({ DTST_IMAGE_API: "openrouter" }), "list_image_models", {});
    expect(textOf(result)).toBe(
      [
        "Default model: test/image-model",
        "2 of 2 models:",
        "- openai/gpt-image-2 (GPT Image 2) [openrouter]",
        "  quality: low|high; n: 1–10",
        "- google/chat-image [chat]",
      ].join("\n"),
    );
  });
});
