#!/usr/bin/env node
/**
 * End-to-end integration test: spawns each MCP server over stdio, drives it
 * with the official MCP client, and makes REAL provider calls.
 *
 *   node --env-file=.env scripts/integration-test.mjs [img|txt|all]
 *
 * Requirements: a built dist (npm run build) and credentials in the
 * environment or a .env file. This script spends real money — a handful of
 * small image and text requests.
 *
 * Exit code 0 only when every assertion passes.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WORK = path.join(ROOT, "sandbox", "mcp-it");

const results = [];
let failures = 0;
let cost = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  else console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function noteCost(usage) {
  if (usage?.costUsd) cost += usage.costUsd;
}

function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function connect(pkg) {
  const entry = path.join(ROOT, "packages", pkg, "dist", "cli.js");
  if (!existsSync(entry)) throw new Error(`Build first: missing ${entry}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: ROOT,
    env: integrationEnv(pkg),
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "dtst-integration", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

/**
 * Both servers read the same variable, `OPENAI_MODEL`. An MCP client points
 * them at different models through their separate env blocks, and this harness
 * does the same for the test run: the image model comes from
 * `DTST_TEST_IMAGE_MODEL` (falling back to `OPENAI_IMAGE_MODEL`, then
 * `OPENAI_MODEL`) and is only ever applied to the img server's environment.
 */
function integrationEnv(pkg) {
  const env = { ...process.env };
  if (pkg === "img") {
    const imageModel = process.env.DTST_TEST_IMAGE_MODEL ?? process.env.OPENAI_IMAGE_MODEL ?? process.env.OPENAI_MODEL;
    if (imageModel) env.OPENAI_MODEL = imageModel;
  }
  return env;
}

async function call(client, name, args, options = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    resetTimeoutOnProgress: true,
    ...options,
  });
  return { result, text: textOf(result) };
}

async function testImg() {
  console.log("\n▶ @dtst/img (MCP stdio, real provider calls)");
  const { client, close, stderr } = await connect("img");
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    check("img: tools registered", names.length === 3, names.join(", "));
    check(
      "img: generate_image has a schema",
      Boolean(tools.tools.find((t) => t.name === "generate_image")?.inputSchema),
    );

    const listed = await call(client, "list_image_models", { query: "muse", limit: 10 });
    check("img: list_image_models responds", listed.text.includes("models:"), listed.text.split("\n")[0]);
    check("img: list_image_models is not an error", listed.result.isError !== true);

    // --- generate ---------------------------------------------------------
    const generated = await call(client, "generate_image", {
      prompt: "a tiny paper boat floating on a rain puddle, macro photograph, soft morning light",
      n: 1,
      output_dir: "sandbox/mcp-it",
      filename: "boat",
    });
    check("img: generate_image succeeded", generated.result.isError !== true, generated.text.split("\n")[0]);
    const structured = generated.result.structuredContent ?? {};
    noteCost(structured.usage);
    const image = structured.images?.[0];
    check("img: returned a saved path", typeof image?.path === "string" && existsSync(image.path), image?.path);
    check("img: sniffed an image mime type", (image?.mimeType ?? "").startsWith("image/"), image?.mimeType);
    check(
      "img: reported dimensions",
      Boolean(image?.width && image?.height),
      image ? `${image.width}x${image.height}` : "-",
    );
    check("img: returned an artifact uri", typeof image?.artifact === "string", image?.artifact);
    const blocks = generated.result.content ?? [];
    check(
      "img: inlined image content block",
      blocks.some((block) => block.type === "image"),
      `${blocks.length} blocks`,
    );
    check(
      "img: returned a resource link",
      blocks.some((block) => block.type === "resource_link"),
    );

    // --- read back the artifact resource ----------------------------------
    if (image?.artifact) {
      const resource = await client.readResource({ uri: image.artifact });
      check(
        "img: artifact resource is readable",
        resource.contents?.some((entry) => Boolean(entry.blob ?? entry.text)),
        resource.contents?.[0]?.mimeType,
      );
      const resources = await client.listResources();
      check(
        "img: artifact appears in resources/list",
        (resources.resources ?? []).some((entry) => entry.uri === image.artifact),
        `${resources.resources?.length ?? 0} resources`,
      );
    }

    // --- edit the generated image via its artifact URI ---------------------
    const edited = await call(client, "edit_image", {
      prompt: "turn this into a soft watercolour illustration, keep the composition",
      images: [image?.artifact ?? image?.path],
      output_dir: "sandbox/mcp-it",
      filename: "boat-watercolour",
    });
    check("img: edit_image via artifact URI succeeded", edited.result.isError !== true, edited.text.split("\n")[0]);
    noteCost(edited.result.structuredContent?.usage);
    const editedImage = edited.result.structuredContent?.images?.[0];
    check("img: edit wrote a new file", Boolean(editedImage?.path && existsSync(editedImage.path)), editedImage?.path);
    check(
      "img: edit produced different bytes",
      editedImage?.bytes && image?.bytes && editedImage.bytes !== image.bytes,
      `${image?.bytes} -> ${editedImage?.bytes}`,
    );

    // --- error path is actionable, not a crash ----------------------------
    const bad = await call(client, "generate_image", {
      prompt: "test",
      model: "definitely/not-a-real-model-xyz",
      output_dir: "sandbox/mcp-it",
    });
    check("img: unknown model reports isError", bad.result.isError === true);
    check("img: error mentions a code", /[A-Z_]{4,}:/.test(bad.text), bad.text.split("\n")[0]?.slice(0, 120));

    if (stderr.length > 0) console.log(`  (server stderr lines: ${stderr.length})`);
  } finally {
    await close();
  }
}

async function testTxt() {
  console.log("\n▶ @dtst/txt (MCP stdio, real provider calls)");
  const { client, close } = await connect("txt");
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    check("txt: tools registered", names.length === 4, names.join(", "));

    const prompts = await client.listPrompts();
    check(
      "txt: write prompt registered",
      prompts.prompts.some((prompt) => prompt.name === "write"),
    );

    const models = await call(client, "list_models", { query: "luna", limit: 5 });
    check("txt: list_models responds", models.text.includes("models:"), models.text.split("\n")[0]);

    // --- read_context on files + images -----------------------------------
    const context = await call(client, "read_context", {
      files: ["sandbox/mcp-it/notes.md"],
      images: ["sandbox/mcp-it/fixture.png"],
    });
    check("txt: read_context is not an error", context.result.isError !== true, context.text.split("\n")[0]);
    const contextStructured = context.result.structuredContent ?? {};
    check(
      "txt: read a text chunk",
      (contextStructured.chunks?.length ?? 0) >= 1,
      `${contextStructured.chunks?.length} chunks`,
    );
    check(
      "txt: read an image",
      (contextStructured.images?.length ?? 0) >= 1,
      `${contextStructured.images?.length} images`,
    );
    check(
      "txt: returned image content blocks",
      (context.result.content ?? []).some((block) => block.type === "image"),
    );

    const resources = await client.listResources();
    check(
      "txt: read files appear as MCP resources",
      (resources.resources ?? []).some((entry) => entry.uri.startsWith("dtst://artifact/")),
      `${resources.resources?.length ?? 0} resources`,
    );
    const firstArtifact = (resources.resources ?? []).find((entry) => entry.uri.startsWith("dtst://artifact/"));
    if (firstArtifact) {
      const read = await client.readResource({ uri: firstArtifact.uri });
      check("txt: artifact resource is readable", (read.contents?.length ?? 0) > 0, read.contents?.[0]?.mimeType);
    }

    // --- write_text with context, images and an output path ---------------
    const written = await call(client, "write_text", {
      instructions: "In one sentence, state what changed in the release notes and what is breaking. No preamble.",
      context: { files: ["sandbox/mcp-it/notes.md"] },
      // One real image plus one missing path: the missing one must be reported, not fatal.
      images: ["sandbox/mcp-it/fixture.png", "sandbox/mcp-it/does-not-exist.png"],
      verbosity: "concise",
      format: "text",
      output_path: "sandbox/mcp-it/release-summary.md",
      overwrite: true,
    });
    check("txt: write_text succeeded", written.result.isError !== true, written.text.split("\n")[0]);
    const writtenStructured = written.result.structuredContent ?? {};
    noteCost(writtenStructured.usage);
    check(
      "txt: wrote the requested file",
      writtenStructured.saved?.path?.endsWith("release-summary.md") === true,
      writtenStructured.saved?.path,
    );
    check(
      "txt: reported usage",
      typeof writtenStructured.usage?.totalTokens === "number",
      JSON.stringify(writtenStructured.usage),
    );
    check(
      "txt: reported context summary",
      (writtenStructured.context?.chunks ?? 0) >= 1,
      JSON.stringify(writtenStructured.context ?? {}),
    );
    check(
      "txt: reported the skipped image",
      (writtenStructured.skippedImages?.length ?? 0) === 1,
      JSON.stringify(writtenStructured.skippedImages ?? []),
    );

    // --- chat -------------------------------------------------------------
    const chat = await call(client, "chat", {
      messages: [
        { role: "user", content: "Reply with exactly the word: PONG" },
        { role: "assistant", content: "PONG" },
        { role: "user", content: "Now reply with exactly the word: PING" },
      ],
      max_tokens: 16,
    });
    check("txt: chat succeeded", chat.result.isError !== true, chat.text.split("\n")[0]);
    check(
      "txt: chat followed the latest turn",
      /PING/i.test(chat.result.structuredContent?.text ?? ""),
      chat.result.structuredContent?.text,
    );
    noteCost(chat.result.structuredContent?.usage);

    // --- prompt template --------------------------------------------------
    const prompt = await client.getPrompt({
      name: "write",
      arguments: { task: "Describe the panda briefly", tone: "playful", length: "one line" },
    });
    check("txt: getPrompt returns a message", (prompt.messages?.length ?? 0) >= 1);

    // --- bad input is reported, not thrown --------------------------------
    const bad = await call(client, "write_text", { instructions: "x", model: "nope/not-a-model" });
    check("txt: unknown model reports isError", bad.result.isError === true);
    check("txt: error is actionable", /[A-Z_]{4,}:/.test(bad.text), bad.text.split("\n")[0]?.slice(0, 140));
  } finally {
    await close();
  }
}

const target = (process.argv[2] ?? "all").toLowerCase();

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Self-contained fixtures so the suite runs anywhere (including CI).
writeFileSync(
  path.join(WORK, "notes.md"),
  [
    "Release 3.2 highlights:",
    "- The image tool now accepts multiple input images.",
    "- Retry logic honours Retry-After headers.",
    "- Breaking: DTST_OUTPUT_DIR now resolves relative to DTST_WORKSPACE.",
    "",
  ].join("\n"),
);
// Smallest valid PNG (1x1, transparent).
writeFileSync(
  path.join(WORK, "fixture.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

if (!process.env.OPENAI_API_KEY && !existsSync(path.join(ROOT, ".env"))) {
  console.error("No credentials: set OPENAI_API_KEY or run with --env-file=.env");
  process.exit(2);
}

const started = Date.now();
if (target === "img" || target === "all") await testImg();
if (target === "txt" || target === "all") await testTxt();

console.log("\n──────── summary ────────");
for (const line of results) console.log(line);
console.log(
  `\n${results.length - failures}/${results.length} checks passed · provider spend ≈ $${cost.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll integration checks passed.");
