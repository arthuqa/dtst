import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DtstError } from "../src/errors";
import { registerSecret } from "../src/log";
import { Server, text } from "../src/server";
import { callTool, connect, tempDir, textOf } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

function testServer(): Server {
  const server = new Server({ name: "test", version: "1" }, "instructions");
  server.tool(
    "echo_root",
    { title: "Echo", description: "Echo", input: { fail: z.boolean().optional() }, annotations: {} },
    async (args, context) => {
      if (args.fail) throw new DtstError("BAD_INPUT", `nope sk-secret-value-123`, "fix it");
      await context.progress("one");
      await context.progress("two");
      return { content: [text(context.root)] };
    },
  );
  return server;
}

describe("Server", () => {
  it("uses the client's root for relative paths", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
    const root = tempDir();
    const client = await connect(testServer(), { root });
    expect(textOf(await callTool(client, "echo_root", {}))).toBe(root);
  });

  it("prefers DTST_WORKSPACE over client roots", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
    vi.stubEnv("DTST_WORKSPACE", "/tmp/elsewhere");
    const client = await connect(testServer(), { root: tempDir() });
    expect(textOf(await callTool(client, "echo_root", {}))).toBe(path.resolve("/tmp/elsewhere"));
  });

  it("returns errors as redacted isError results with code and hint", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
    registerSecret("sk-secret-value-123");
    const client = await connect(testServer());
    const result = await callTool(client, "echo_root", { fail: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("BAD_INPUT: nope «redacted»\nHint: fix it");
  });

  it("reports configuration problems as tool errors, not crashes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.example.com/v1");
    const client = await connect(testServer());
    const result = await callTool(client, "echo_root", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^CONFIG: OPENAI_API_KEY is not set/);
  });

  it("sends strictly increasing progress values", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-123456");
    const client = await connect(testServer());
    const seen: number[] = [];
    await client.callTool({ name: "echo_root", arguments: {} }, undefined, {
      onprogress: (progress) => void seen.push(progress.progress),
    });
    expect(seen).toEqual([1, 2]);
  });
});
