import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  DtstError,
  type ServerLike,
  artifactBlocks,
  defineTool,
  fail,
  ok,
  registerArtifactResources,
  registerSecret,
  text,
} from "@dtst/internal";
import { z } from "zod";
import { cleanupDir, makeTempDir } from "./helpers";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir("dtst-mcp-");
});

afterEach(async () => {
  await cleanupDir(dir);
});

describe("ok / fail", () => {
  it("ok() wraps content and optional structured data", () => {
    const single = ok(text("hi"));
    expect(single.content).toHaveLength(1);
    expect(single.structuredContent).toBeUndefined();
    expect(single.isError).toBeUndefined();

    const withStructured = ok([], { a: 1 });
    expect(withStructured.content[0]).toEqual({ type: "text", text: "ok" });
    expect(withStructured.structuredContent).toEqual({ a: 1 });
  });

  it("fail() returns the stable code, message and hint", () => {
    const result = fail(new DtstError("BAD_INPUT", "nope", { hint: "try again" }));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.structuredContent).toMatchObject({
      error: { code: "BAD_INPUT", message: "nope", hint: "try again" },
    });
  });

  it("fail() never leaks a registered secret", () => {
    const secret = "sk-verysecretvalue123";
    registerSecret(secret);
    const result = fail(new Error(`provider rejected key ${secret}`));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((result.content[0] as { text: string }).text).toContain("«redacted»");
  });
});

describe("artifactBlocks", () => {
  it("returns a resource_link, an embedded resource and an artifact text line", async () => {
    const file = path.join(dir, "note.txt");
    await writeFile(file, "hello");
    const store = new ArtifactStore();

    const blocks = artifactBlocks({
      store,
      path: file,
      kind: "text",
      bytes: 5,
      mimeType: "text/plain",
      label: "note.txt",
      content: "hello",
      inline: "hello",
      inlineMimeType: "text/plain",
    });

    const [link] = blocks;
    expect(link).toMatchObject({ type: "resource_link", name: "note.txt" });
    expect((link as { uri: string }).uri.startsWith("file://")).toBe(true);

    const embedded = blocks.find((block) => block.type === "resource") as { resource: { text?: string } } | undefined;
    expect(embedded?.resource.text).toBe("hello");

    const summary = blocks.find((block) => block.type === "text") as { text: string } | undefined;
    expect(summary?.text).toContain("Artifact: dtst://artifact/");
    expect(store.list()).toHaveLength(1);
  });

  it("embeds bytes for binary payloads", async () => {
    const file = path.join(dir, "blob.bin");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const store = new ArtifactStore();
    const blocks = artifactBlocks({
      store,
      path: file,
      kind: "file",
      bytes: 3,
      inline: Buffer.from([1, 2, 3]),
      mimeType: "application/octet-stream",
    });
    const embedded = blocks.find((block) => block.type === "resource") as { resource: { blob?: string } } | undefined;
    expect(embedded?.resource.blob).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

describe("defineTool", () => {
  interface Registered {
    name: string;
    config: unknown;
    handler: (input: unknown, extra: unknown) => Promise<CallToolResult>;
  }

  function fakeServer(): { server: ServerLike; calls: Registered[] } {
    const calls: Registered[] = [];
    const server = {
      registerTool: (
        name: string,
        config: unknown,
        handler: (input: never, extra: never) => Promise<CallToolResult> | CallToolResult,
      ) => {
        calls.push({ name, config, handler: handler as Registered["handler"] });
        return {};
      },
    } as unknown as ServerLike;
    return { server, calls };
  }

  it("passes successful results through unchanged", async () => {
    const { server, calls } = fakeServer();
    defineTool(server, { name: "t", description: "d", inputSchema: z.string() }, async () => ok(text("fine")));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("t");
    const result = await calls[0]!.handler("input", undefined);
    expect(result.content[0]).toEqual({ type: "text", text: "fine" });
  });

  it("converts a thrown error into an isError result", async () => {
    const { server, calls } = fakeServer();
    defineTool(server, { name: "boom", description: "d", inputSchema: z.string() }, async () => {
      throw new DtstError("BAD_INPUT", "wrong");
    });
    const result = await calls[0]!.handler("input", undefined);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "BAD_INPUT" } });
  });
});

describe("registerArtifactResources", () => {
  class FakeTemplate {
    constructor(
      public readonly uri: string,
      public readonly options?: { list?: unknown },
    ) {}
  }

  it("registers with four arguments and reads a saved text artifact", async () => {
    const file = path.join(dir, "artifact.txt");
    await writeFile(file, "hello artifact");
    const store = new ArtifactStore();
    const artifact = store.save({ path: file, kind: "text", bytes: 14, mimeType: "text/plain", label: "artifact.txt" });

    const registrationArgs: unknown[][] = [];
    const server = {
      registerResource: (...args: unknown[]) => {
        registrationArgs.push(args);
        return {};
      },
    };

    registerArtifactResources(server, store, FakeTemplate);

    expect(registrationArgs).toHaveLength(1);
    expect(registrationArgs[0]).toHaveLength(4);
    expect(registrationArgs[0]?.[0]).toBe("artifact");
    expect(registrationArgs[0]?.[1]).toBeInstanceOf(FakeTemplate);
    expect(registrationArgs[0]?.[2]).toMatchObject({ title: "Saved artifact" });

    const handler = registrationArgs[0]?.[3] as (uri: URL) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text?: string }>;
    }>;
    const result = await handler(new URL(artifact.uri));
    expect(result.contents[0]?.mimeType).toBe("text/plain");
    expect(result.contents[0]?.text).toBe("hello artifact");
  });
});
