import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DtstError, resetClientCache, toDtstError } from "@dtst/internal";
import { runChat, runWriteText } from "../../src/operations";
import {
  bodyAt,
  chatCompletion,
  installFetch,
  jsonResponse,
  makeConfig,
  makeOperationContext,
  messagesOf,
  PNG_1X1,
  type FetchStub,
} from "./helpers";

let tmpRoot: string;
let fetchStub: FetchStub;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dtst-txt-ops-"));
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

async function writeTextFile(name: string, content: string): Promise<string> {
  const full = path.join(tmpRoot, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  return full;
}

async function writePng(name: string): Promise<string> {
  const full = path.join(tmpRoot, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, PNG_1X1);
  return full;
}

function config(): ReturnType<typeof makeConfig> {
  return makeConfig({ workspaceRoot: tmpRoot });
}

describe("runWriteText", () => {
  it("runs end to end: context, images, save, usage and artifact blocks", async () => {
    const sourcePath = await writeTextFile("source.txt", "source material body");
    const imagePath = await writePng("pixel.png");
    const outputPath = path.join(tmpRoot, "out", "result.md");
    fetchStub.respond(() => jsonResponse(chatCompletion("MODEL TEXT")));

    const { context, progressCalls } = makeOperationContext(config());
    const outcome = await runWriteText(
      {
        instructions: "Summarise the source",
        context: { files: [sourcePath] },
        images: [imagePath],
        output_path: outputPath,
      },
      context,
    );

    expect(outcome.text).toBe("MODEL TEXT");
    expect(outcome.saved?.path).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(await fs.readFile(outputPath, "utf8")).toBe("MODEL TEXT");

    expect(outcome.structured).toMatchObject({
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      context: { chunks: 1, images: 1, skipped: 0 },
    });
    expect(outcome.structured["chars"]).toBe("MODEL TEXT".length);

    const types = outcome.content.map((block) => block.type);
    expect(types).toContain("resource_link");
    expect(types).toContain("resource");
    expect(outcome.content.some((block) => block.type === "text" && block.text === "MODEL TEXT")).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);

    const body = bodyAt(fetchStub, 0);
    const messages = messagesOf(body);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(Array.isArray(messages[1]?.content)).toBe(true);
  });

  it("writes nothing when save is false and no destination is given", async () => {
    fetchStub.respond(() => jsonResponse(chatCompletion("inline only")));
    const { context } = makeOperationContext(config());

    const outcome = await runWriteText({ instructions: "Just answer", save: false }, context);

    expect(outcome.saved).toBeUndefined();
    expect(outcome.structured["saved"]).toBeUndefined();
    expect(fetchStub.requests).toHaveLength(1);
  });

  it("suffixes the second write when overwrite is false", async () => {
    const target = path.join(tmpRoot, "dup.md");
    const { context } = makeOperationContext(config());

    fetchStub.respond(() => jsonResponse(chatCompletion("first")));
    const first = await runWriteText({ instructions: "dup task", output_path: target, overwrite: false }, context);

    fetchStub.respond(() => jsonResponse(chatCompletion("second")));
    const second = await runWriteText({ instructions: "dup task", output_path: target, overwrite: false }, context);

    expect(first.saved?.path).toBe(target);
    expect(second.saved?.path).toBe(path.join(tmpRoot, "dup-1.md"));
    expect(existsSync(target)).toBe(true);
    expect(existsSync(path.join(tmpRoot, "dup-1.md"))).toBe(true);
  });

  it("degrades gracefully when one image cannot be read", async () => {
    const imagePath = await writePng("good.png");
    const missingPath = path.join(tmpRoot, "does-not-exist.png");
    fetchStub.respond(() => jsonResponse(chatCompletion("vision answer")));

    const { context } = makeOperationContext(config());
    const outcome = await runWriteText({ instructions: "Look", images: [missingPath, imagePath] }, context);

    const skipped = outcome.structured["skippedImages"] as Array<{ source: string; reason: string }>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.source).toBe(missingPath);
    expect(typeof skipped[0]?.reason).toBe("string");
    expect(outcome.content.some((block) => block.type === "text" && block.text.includes("Skipped 1 image(s)"))).toBe(
      true,
    );

    // Only the readable image is attached to the request.
    const messages = messagesOf(bodyAt(fetchStub, 0));
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(Array.isArray(last?.content)).toBe(true);
    expect(last?.content).toHaveLength(2);
  });

  it("sets response_format when format is json", async () => {
    fetchStub.respond(() => jsonResponse(chatCompletion('{"ok":true}')));
    const { context } = makeOperationContext(config());

    await runWriteText({ instructions: "Return json", format: "json" }, context);

    const body = bodyAt(fetchStub, 0);
    expect(body["response_format"]).toEqual({ type: "json_object" });
  });

  it("surfaces a provider 401 as PROVIDER_AUTH without swallowing it", async () => {
    fetchStub.respond(() => jsonResponse({ error: { message: "Invalid API key" } }, 401));
    const { context } = makeOperationContext(config());

    const error = await runWriteText({ instructions: "x" }, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(toDtstError(error).code).toBe("PROVIDER_AUTH");
  });
});

describe("runChat", () => {
  it("sends the whole conversation and attaches images only to the last user turn", async () => {
    const imagePath = await writePng("chat.png");
    fetchStub.respond(() => jsonResponse(chatCompletion("reply")));
    const { context } = makeOperationContext(config());

    await runChat(
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
        images: [imagePath],
      },
      context,
    );

    const messages = messagesOf(bodyAt(fetchStub, 0));
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "first" });
    expect(messages[2]).toEqual({ role: "assistant", content: "second" });
    expect(messages[3]?.role).toBe("user");
    expect(Array.isArray(messages[3]?.content)).toBe(true);
    expect(messages[3]?.content).toHaveLength(2);
  });

  it("maps sampling parameters and omits absent ones", async () => {
    const { context } = makeOperationContext(config());

    fetchStub.respond(() => jsonResponse(chatCompletion("a")));
    await runChat(
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 50,
        temperature: 0.5,
        top_p: 0.9,
        stop: ["END"],
        reasoning_effort: "high",
      },
      context,
    );

    const full = bodyAt(fetchStub, 0);
    expect(full).toMatchObject({
      max_completion_tokens: 50,
      temperature: 0.5,
      top_p: 0.9,
      stop: ["END"],
      reasoning_effort: "high",
    });

    fetchStub.respond(() => jsonResponse(chatCompletion("b")));
    await runChat({ messages: [{ role: "user", content: "hi" }] }, context);

    const bare = bodyAt(fetchStub, 1);
    for (const key of [
      "max_completion_tokens",
      "temperature",
      "top_p",
      "stop",
      "reasoning_effort",
      "response_format",
    ]) {
      expect(bare).not.toHaveProperty(key);
    }
  });

  it("rejects an empty message list", async () => {
    const { context } = makeOperationContext(config());
    const error = await runChat({ messages: [] }, context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DtstError);
    expect((error as DtstError).code).toBe("BAD_INPUT");
  });
});
