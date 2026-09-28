import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore, resetClientCache, type ServerLike } from "@dtst/internal";
import { createToolRuntime } from "../../src/runtime";
import { registerChatTool, chatSchema } from "../../src/tools/chat";
import { registerListModelsTool, listModelsSchema } from "../../src/tools/models";
import { registerReadContextTool, readContextSchema } from "../../src/tools/read-context";
import { registerWriteTextTool, writeTextSchema } from "../../src/tools/write";
import { chatCompletion, installFetch, jsonResponse, makeConfig, type FetchStub } from "./helpers";

let tmpRoot: string;
let fetchStub: FetchStub;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dtst-txt-tools-"));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fetchStub = installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetClientCache();
});

interface CapturedTool {
  name: string;
  config: { description?: string; title?: string; annotations?: unknown; inputSchema?: unknown };
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
}

function fakeServer(): { server: ServerLike; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    registerTool: (name: string, config: CapturedTool["config"], handler: CapturedTool["handler"]) => {
      tools.push({ name, config, handler });
      return undefined;
    },
  };
  return { server: server as unknown as ServerLike, tools };
}

function runtime() {
  return createToolRuntime({ config: makeConfig({ workspaceRoot: tmpRoot }), artifacts: new ArtifactStore() });
}

describe("tool schemas", () => {
  it("write_text accepts a realistic input", () => {
    const parsed = writeTextSchema.safeParse({
      instructions: "Summarise the release notes",
      input: "inline",
      context: { files: ["a.md"], text: ["snippet"] },
      images: ["a.png"],
      max_tokens: 512,
      temperature: 0.3,
      format: "markdown",
      output_path: "out.md",
    });
    expect(parsed.success).toBe(true);
  });

  it("write_text rejects bad inputs", () => {
    expect(writeTextSchema.safeParse({ instructions: "" }).success).toBe(false);
    expect(writeTextSchema.safeParse({ instructions: "x", images: Array.from({ length: 17 }, (_, i) => `i-${i}.png`) }).success).toBe(false);
    expect(writeTextSchema.safeParse({ instructions: "x", max_tokens: 0 }).success).toBe(false);
    expect(writeTextSchema.safeParse({ instructions: "x", temperature: 5 }).success).toBe(false);
    expect(writeTextSchema.safeParse({ instructions: "x", format: "yaml" }).success).toBe(false);
  });

  it("chat requires at least one message and valid roles", () => {
    expect(chatSchema.safeParse({ messages: [{ role: "user", content: "hi" }] }).success).toBe(true);
    expect(chatSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatSchema.safeParse({ messages: [{ role: "tool", content: "hi" }] }).success).toBe(false);
    expect(chatSchema.safeParse({ messages: [{ role: "user", content: "hi" }], images: Array.from({ length: 17 }, (_, i) => `i-${i}.png`) }).success).toBe(false);
  });

  it("read_context validates budgets and flags", () => {
    expect(
      readContextSchema.safeParse({
        files: ["a.md"],
        dirs: ["src"],
        urls: ["https://example.com"],
        text: ["hi"],
        images: ["a.png"],
        max_bytes_per_source: 4096,
        include_content: false,
      }).success,
    ).toBe(true);
    expect(readContextSchema.safeParse({ files: ["a.md"], max_bytes_per_source: 10 }).success).toBe(false);
    expect(readContextSchema.safeParse({ files: ["a.md"], include_content: "yes" }).success).toBe(false);
  });

  it("list_models validates the limit range", () => {
    expect(listModelsSchema.safeParse({ query: "gpt", limit: 5 }).success).toBe(true);
    expect(listModelsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listModelsSchema.safeParse({ limit: 1001 }).success).toBe(false);
  });
});

describe("tool registration", () => {
  it("registers all four tools with descriptions and annotations", () => {
    const { server, tools } = fakeServer();
    const toolRuntime = runtime();
    registerWriteTextTool(server, toolRuntime);
    registerChatTool(server, toolRuntime);
    registerReadContextTool(server, toolRuntime);
    registerListModelsTool(server, toolRuntime);

    expect(tools.map((tool) => tool.name)).toEqual(["write_text", "chat", "read_context", "list_models"]);
    for (const tool of tools) {
      expect((tool.config.description ?? "").length).toBeGreaterThan(0);
      expect(tool.config.title).toBeTruthy();
      expect(tool.config.annotations).toBeDefined();
      expect(tool.config.inputSchema).toBeDefined();
    }
  });

  it("invokes the captured write_text handler end to end", async () => {
    const { server, tools } = fakeServer();
    registerWriteTextTool(server, runtime());
    const tool = tools.find((entry) => entry.name === "write_text");
    expect(tool).toBeDefined();

    fetchStub.respond(() => jsonResponse(chatCompletion("handler text")));
    const outputPath = path.join(tmpRoot, "handler-out.md");

    const result = (await tool?.handler({ instructions: "Write it", output_path: outputPath }, {})) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ model: "test-model", text: "handler text" });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.some((block) => block.type === "text" && block.text?.includes("handler text"))).toBe(true);
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("handler text");
  });
});
