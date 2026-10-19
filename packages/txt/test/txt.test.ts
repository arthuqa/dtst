import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeProvider,
  PNG_1x1,
  callTool,
  connect,
  fakeProvider,
  tempDir,
  textOf,
} from "../../internal/test/helpers";
import { createServer } from "../src/server";

let provider: FakeProvider;
let root: string;

const reply = (content: string, extra: Record<string, unknown> = {}) => ({
  json: {
    model: "test/text-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
    ...extra,
  },
});

async function client(env: Record<string, string> = {}) {
  vi.stubEnv("OPENAI_BASE_URL", provider.url);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
  vi.stubEnv("OPENAI_MODEL", "test/text-model");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return connect(createServer(), { root });
}

beforeEach(async () => {
  provider = await fakeProvider();
  root = tempDir();
  writeFileSync(path.join(root, "notes.md"), "Release 3.2: faster retries.");
  writeFileSync(path.join(root, "shot.png"), PNG_1x1);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await provider.close();
});

describe("generate_text", () => {
  it("answers a prompt and reports usage", async () => {
    provider.on("POST /chat/completions", reply("Hello!"));
    const result = await callTool(await client(), "generate_text", {
      prompt: "Say hello",
      max_tokens: 50,
      temperature: 0,
    });

    const body = provider.requests[0]?.json;
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "Say hello" });
    expect(body.messages[0].role).toBe("system");
    expect(body).toMatchObject({ model: "test/text-model", max_tokens: 50, temperature: 0 });
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.structuredContent).toEqual({
      text: "Hello!",
      model: "test/text-model",
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 },
    });
  });

  it("grounds the last user turn in files and attaches images", async () => {
    provider.on("POST /chat/completions", reply("A pixel."));
    const result = await callTool(await client(), "generate_text", {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      prompt: "What changed, and what is in the picture?",
      files: ["notes.md", "shot.png", "missing.txt"],
    });
    const last = provider.requests[0]?.json.messages.at(-1);
    expect(provider.requests[0]?.json.messages).toHaveLength(4);
    expect(last.role).toBe("user");
    expect(last.content[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_1x1.toString("base64")}` },
    });
    expect(last.content[1].text).toBe(
      `<file path="${path.join(root, "notes.md")}">\nRelease 3.2: faster retries.\n</file>\n\nWhat changed, and what is in the picture?`,
    );
    expect(textOf(result)).toMatch(/Skipped: missing\.txt: Not found/);
  });

  it("uses JSON mode and saves to a file without clobbering", async () => {
    provider.on("POST /chat/completions", reply('{"ok":true}'));
    writeFileSync(path.join(root, "out.json"), "keep");
    const c = await client();
    const result = await callTool(c, "generate_text", { prompt: "status", json: true, output: "out.json" });
    expect(provider.requests[0]?.json.response_format).toEqual({ type: "json_object" });
    const saved = path.join(root, "out-1.json");
    expect(readFileSync(saved, "utf8")).toBe('{"ok":true}');
    expect(result.content.map((block) => block.type)).toEqual(["resource_link", "text"]);
    expect((result.structuredContent as { path: string }).path).toBe(saved);
  });

  it("returns only path and preview for saved files, unless return_text is set", async () => {
    const html = ["<!DOCTYPE html>", ...Array.from({ length: 300 }, (_, i) => `<li>task ${i}</li>`), "</html>"].join(
      "\n",
    );
    provider.on("POST /chat/completions", reply(html));
    const c = await client();

    const lean = await callTool(c, "generate_text", { prompt: "Build a TODO app", output: "todo/index.html" });
    const file = path.join(root, "todo", "index.html");
    expect(readFileSync(file, "utf8")).toBe(html);
    expect(JSON.stringify(lean)).not.toContain("task 299");
    expect(lean.structuredContent).toEqual({
      model: "test/text-model",
      path: file,
      bytes: Buffer.byteLength(html),
      preview: html.split("\n").slice(0, 6).join("\n"),
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 },
    });
    expect(textOf(lean)).toMatch(
      new RegExp(`^Saved [\\d.]+ KB \\(302 lines\\) to ${file}\\nPreview:\\n<!DOCTYPE html>`),
    );
    expect(lean.content.find((block) => block.type === "resource_link")).toMatchObject({ mimeType: "text/html" });

    const full = await callTool(c, "generate_text", { prompt: "x", output: "todo/index.html", return_text: true });
    expect((full.structuredContent as { text: string }).text).toBe(html);
    expect(full.content[0]).toEqual({ type: "text", text: html });
  });

  it("names the configured model in the tool schema and instructions", async () => {
    const c = await client();
    const tool = (await c.listTools()).tools.find((entry) => entry.name === "generate_text");
    expect((tool!.inputSchema.properties!["model"] as { description: string }).description).toMatch(
      /^Omit to use the configured model \(test\/text-model\)/,
    );
    expect(c.getInstructions()).toContain("Configured model: test/text-model.");
  });

  it("defaults saved text to Markdown named after the prompt", async () => {
    provider.on("POST /chat/completions", reply("# Summary"));
    await callTool(await client(), "generate_text", { prompt: "Summarise the release", output: "reports/" });
    expect(readFileSync(path.join(root, "reports", "summarise-release.md"), "utf8")).toBe("# Summary");
  });

  it("uses max_completion_tokens against api.openai.com only", async () => {
    // Exercised through the exported helper to avoid real network calls.
    const { complete } = await import("../src/server");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(reply("ok").json)));
    await complete(
      {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        imageApi: "auto",
        timeoutMs: 5000,
        headers: {},
        openRouter: false,
      },
      { model: "gpt", messages: [{ role: "user", content: "x" }], max_tokens: 9, signal: new AbortController().signal },
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({ max_completion_tokens: 9 });
    fetchSpy.mockRestore();
  });

  it("turns empty or cut-off replies into actionable errors", async () => {
    provider.on("POST /chat/completions", {
      json: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    });
    const result = await callTool(await client(), "generate_text", { prompt: "think hard" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/whole token budget[\s\S]*Raise `max_tokens`/);
  });

  it("requires a prompt or messages, and a model", async () => {
    expect(textOf(await callTool(await client(), "generate_text", {}))).toMatch(/^BAD_INPUT/);
    expect(textOf(await callTool(await client({ OPENAI_MODEL: "" }), "generate_text", { prompt: "x" }))).toMatch(
      /^CONFIG/,
    );
  });
});

describe("read_files", () => {
  it("returns text and images together, with skipped sources", async () => {
    const result = await callTool(await client(), "read_files", { sources: ["notes.md", "shot.png", "nope.md"] });
    expect(result.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(textOf(result)).toMatch(/<file path=".*notes\.md">\nRelease 3\.2/);
    expect(textOf(result)).toMatch(/Skipped:\n- nope\.md: Not found/);
  });
});

describe("list_text_models", () => {
  it("lists models with context, vision and price", async () => {
    provider.on("GET /models", {
      json: {
        data: [
          {
            id: "openai/gpt-6-luna",
            context_length: 1_050_000,
            architecture: { input_modalities: ["text", "image"] },
            pricing: { prompt: "0.0000001", completion: "0.0000005" },
          },
          { id: "local/tiny" },
        ],
      },
    });
    const result = await callTool(await client(), "list_text_models", { query: "luna" });
    expect(textOf(result)).toBe(
      [
        "Default model: test/text-model",
        "1 of 2 models:",
        "- openai/gpt-6-luna · 1050k ctx · vision · $0.1/$0.5 per M tokens",
      ].join("\n"),
    );
  });
});
