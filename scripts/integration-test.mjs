#!/usr/bin/env node
/**
 * Live end-to-end test: spawns the built servers over stdio, drives every tool with the
 * official MCP client and makes REAL provider calls (costs a few cents).
 *
 *   npm run build && npm run test:integration [img|txt|tts]
 *
 * Uses OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL / OPENAI_IMAGE_MODEL /
 * OPENAI_SPEECH_MODEL / OPENAI_VOICE / DTST_SPEECH_API from the environment or .env.
 * A Fish Audio base URL (api.fish.audio) runs the native /v1/tts checks, including drama-3. Exit code: 0 all passed, 1 failures, 3 only blocked by provider credits.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WORK = path.join(ROOT, "sandbox", "it");
const only = process.argv[2];
const tally = { pass: 0, fail: 0, blocked: 0 };

function check(name, ok, detail = "") {
  tally[ok ? "pass" : "fail"] += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
}

const textOf = (result) =>
  (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

/** A real, solid-colour PNG so vision models have something unambiguous to look at. */
function solidPng(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function connect(pkg) {
  const entry = path.join(ROOT, "packages", pkg, "dist", "index.js");
  if (!existsSync(entry)) throw new Error(`Build first: missing ${entry}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, DTST_WORKSPACE: WORK },
    stderr: "pipe",
  });
  const client = new Client({ name: "dtst-integration", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
    resetTimeoutOnProgress: true,
    onprogress: () => {},
  });
  return { result, text: textOf(result), ms: Date.now() - started };
}

/** An image call that fails only because the account is out of credits is "blocked", not failed. */
function blockedByCredits(name, { result, text }) {
  if (result.isError && text.startsWith("CREDITS:")) {
    tally.blocked += 1;
    console.log(`  ⊘ ${name} — BLOCKED: ${text.split("\n")[0]}`);
    return true;
  }
  return false;
}

async function testTxt() {
  console.log(`\n▶ dtst-txt · ${process.env.OPENAI_MODEL}`);
  const client = await connect("txt");
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    check("tools", tools.join() === "generate_text,list_text_models,read_files", tools.join(", "));

    let r = await call(client, "list_text_models", { query: process.env.OPENAI_MODEL, limit: 3 });
    check(
      "list_text_models finds the configured model",
      !r.result.isError && r.text.split("\n").some((line) => line.startsWith(`- ${process.env.OPENAI_MODEL} `)),
      r.text.split("\n")[2],
    );

    r = await call(client, "read_files", { sources: ["notes.md", "red.png", "missing.md"] });
    const types = r.result.content.map((block) => block.type).join();
    check(
      "read_files returns text + image + skipped",
      types === "text,image,text" && r.text.includes("Release 3.2"),
      types,
    );

    r = await call(client, "read_files", { sources: ["*.md", "red.png"], grep: "breaking" });
    check(
      "read_files grep returns only matching lines",
      /^<file path=".*notes\.md" matches="1">\n4: - Breaking:/.test(r.text) && !r.text.includes("Release 3.2"),
      r.text.split("\n").slice(0, 2).join(" | "),
    );

    r = await call(client, "generate_text", {
      prompt: "Reply with exactly: PONG",
      max_tokens: 200,
      reasoning_effort: "low",
    });
    check("generate_text prompt", !r.result.isError && /PONG/.test(r.text), `${r.text.split("\n")[0]} · ${r.ms}ms`);
    const usage = r.result.structuredContent?.usage;
    check("generate_text reports usage", usage?.input_tokens > 0, JSON.stringify(usage));

    r = await call(client, "generate_text", {
      messages: [
        { role: "user", content: "The code word is HERON. Acknowledge briefly." },
        { role: "assistant", content: "Noted." },
      ],
      prompt: "What is the code word? Answer with the word only.",
      max_tokens: 200,
    });
    check("generate_text multi-turn", /HERON/i.test(r.text), r.text.split("\n")[0]);

    r = await call(client, "generate_text", {
      prompt: "What is the dominant colour of the attached image? One lowercase word.",
      files: ["red.png"],
      max_tokens: 200,
    });
    check("generate_text vision (image file)", /red/i.test(r.text), r.text.split("\n")[0]);

    r = await call(client, "generate_text", {
      prompt: "Summarise these release notes as exactly 3 Markdown bullets.",
      files: ["notes.md"],
      system: "Audience: non-technical users.",
      output: "reports/summary.md",
      max_tokens: 600,
    });
    const saved = r.result.structuredContent?.path;
    check(
      "generate_text grounded + saved to file",
      saved?.endsWith("reports/summary.md") && readFileSync(saved, "utf8").includes("-"),
      saved,
    );

    r = await call(client, "generate_text", {
      prompt: 'Return {"colour": <the colour of the image>, "release": <release number in the notes>}',
      files: ["notes.md", "red.png"],
      json: true,
      max_tokens: 300,
    });
    let parsed;
    try {
      parsed = JSON.parse(r.result.structuredContent?.text ?? "");
    } catch {}
    check(
      "generate_text json mode",
      /red/i.test(parsed?.colour ?? "") && /3\.2/.test(String(parsed?.release)),
      JSON.stringify(parsed),
    );

    const tool = (await client.listTools()).tools.find((entry) => entry.name === "generate_text");
    check(
      "schema names the configured model",
      tool.inputSchema.properties.model.description.includes(`(${process.env.OPENAI_MODEL})`),
      tool.inputSchema.properties.model.description,
    );

    r = await call(client, "generate_text", {
      prompt:
        "Create a complete single-file TODO app: index.html with inline CSS and JS, add/complete/delete tasks, persisted in localStorage. Return only the HTML.",
      output: "todo/index.html",
      max_tokens: 8000,
      reasoning_effort: "low",
    });
    const todo = r.result.structuredContent ?? {};
    const html = todo.path && existsSync(todo.path) ? readFileSync(todo.path, "utf8") : "";
    check(
      "TODO app saved as HTML",
      /<html[\s>]/i.test(html) && /localStorage/.test(html) && /<\/html>\s*$/i.test(html),
      `${todo.path} · ${html.length} chars · ${r.ms}ms`,
    );
    const returned = JSON.stringify(r.result).length;
    check(
      "only path + preview returned to the agent",
      todo.text === undefined && returned < 2000 && returned < html.length / 4,
      `${returned} chars returned vs ${html.length} in the file`,
    );

    r = await call(client, "generate_text", { prompt: "hi", model: "nope/not-a-model" });
    check(
      "unknown model → actionable error",
      r.result.isError && /^UNSUPPORTED: [\s\S]*Hint: /.test(r.text),
      r.text.split("\n")[0],
    );
  } finally {
    await client.close();
  }
}

async function testImg() {
  console.log(`\n▶ dtst-img · ${process.env.OPENAI_IMAGE_MODEL ?? process.env.OPENAI_MODEL}`);
  const client = await connect("img");
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    check("tools", tools.join() === "edit_image,generate_image,list_image_models", tools.join(", "));

    const imageModel = process.env.OPENAI_IMAGE_MODEL ?? "";
    let r = await call(client, "list_image_models", { query: imageModel.split("/").pop() });
    check(
      "list_image_models finds the configured model",
      !r.result.isError && r.text.includes(`- ${imageModel}`),
      r.text.split("\n")[2],
    );

    r = await call(client, "generate_image", {
      prompt: "A watercolour red panda reading a book, soft light",
      aspect_ratio: "1:1",
      output: "img/panda.webp",
    });
    let generated;
    if (!blockedByCredits("generate_image", r)) {
      generated = r.result.structuredContent?.images?.[0];
      check(
        "generate_image saved a file",
        !r.result.isError && generated && existsSync(generated.path),
        r.text.split("\n")[1] ?? r.text,
      );
      check(
        "generate_image inline preview",
        r.result.content.some((block) => block.type === "image"),
      );
      check(
        "generate_image resource link",
        r.result.content.some((block) => block.type === "resource_link"),
      );
    }

    r = await call(client, "edit_image", {
      prompt: "Turn this into a blue square",
      images: [generated?.path ?? "red.png"],
      output: "img/edited.png",
    });
    if (!blockedByCredits("edit_image", r)) {
      const edited = r.result.structuredContent?.images?.[0];
      check(
        "edit_image saved a file",
        !r.result.isError && edited && existsSync(edited.path),
        r.text.split("\n")[1] ?? r.text,
      );
    }

    r = await call(client, "generate_image", { prompt: "x", model: process.env.OPENAI_MODEL });
    check(
      "text model → explained error",
      r.result.isError && /does not generate images|Unknown model/.test(r.text),
      r.text.split("\n")[0],
    );

    r = await call(client, "edit_image", { prompt: "x", images: ["missing.png"] });
    check("missing input → BAD_INPUT", r.result.isError && r.text.startsWith("BAD_INPUT"), r.text.split("\n")[0]);
  } finally {
    await client.close();
  }
}

async function testTts() {
  const speechModel = process.env.OPENAI_SPEECH_MODEL ?? process.env.OPENAI_MODEL ?? "";
  console.log(`\n▶ dtst-tts · ${speechModel} · voice ${process.env.OPENAI_VOICE ?? "default"}`);
  const client = await connect("tts");
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    check("tools", tools.join() === "generate_speech,list_speech_models", tools.join(", "));

    let r = await call(client, "list_speech_models", { query: speechModel, limit: 3 });
    check(
      "list_speech_models finds the configured model",
      !r.result.isError &&
        r.text
          .split("\n")
          .some((line) =>
            [speechModel, speechModel.replace(/^fish-audio\//, "")].some((id) => line.startsWith(`- ${id} `)),
          ),
      r.text.split("\n")[2],
    );

    r = await call(client, "generate_speech", { text: "Hello from the dtst speech server.", output: "tts/hello.mp3" });
    if (!blockedByCredits("generate_speech mp3", r)) {
      const saved = r.result.structuredContent ?? {};
      const bytes = saved.path && existsSync(saved.path) ? readFileSync(saved.path) : Buffer.alloc(0);
      const mp3 =
        bytes.subarray(0, 3).toString("latin1") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
      check(
        "generate_speech saved an mp3",
        !r.result.isError && saved.path?.endsWith("tts/hello.mp3") && mp3 && bytes.length > 1000,
        `${saved.path ?? r.text.split("\n")[0]} · ${bytes.length} B · ${r.ms}ms`,
      );
      check(
        "generate_speech resource link",
        r.result.content.some((block) => block.type === "resource_link" && block.mimeType === "audio/mpeg"),
      );
    }

    r = await call(client, "generate_speech", { file: "notes.md", output: "tts/notes.wav", inline: true });
    if (!blockedByCredits("generate_speech wav from file", r)) {
      const saved = r.result.structuredContent ?? {};
      const bytes = saved.path && existsSync(saved.path) ? readFileSync(saved.path) : Buffer.alloc(0);
      check(
        "generate_speech wav from a file",
        !r.result.isError &&
          bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
          bytes.subarray(8, 12).toString("latin1") === "WAVE" &&
          saved.duration_s > 2,
        `${saved.path ?? r.text.split("\n")[0]} · ${saved.duration_s}s · ${r.ms}ms`,
      );
      check(
        "generate_speech inline audio",
        r.result.content.some((block) => block.type === "audio" && block.mimeType === "audio/wav"),
      );
    }

    r = await call(client, "generate_speech", { text: "Hi", voice: "no-such-voice-xyz" });
    if (!blockedByCredits("unknown voice", r)) {
      check("unknown voice → actionable error", r.result.isError && /Hint: /.test(r.text), r.text.split("\n")[0]);
    }

    const fish =
      process.env.DTST_SPEECH_API === "fish" ||
      ((process.env.DTST_SPEECH_API ?? "auto") === "auto" &&
        /(^|\.)fish\.audio$/.test(new URL(process.env.OPENAI_BASE_URL ?? "https://x").hostname));
    if (fish) {
      // Fish falls back to its default model for unknown ids, so exercise drama-3 features instead.
      r = await call(client, "generate_speech", {
        model: "drama-3",
        text: "<|speaker:0|>[low, tired] Status report.<|speaker:1|>[nervous] It is, uh, <emphasis>not</emphasis> great.",
        voice: "bf322df2096a46f18c579d0baa36f41d, f3a2b90078d54a65af4b95f63bc7798e",
        output: "tts/scene.mp3",
      });
      const scene = r.result.structuredContent ?? {};
      check(
        "drama-3 multi-speaker scene",
        !r.result.isError && scene.path && existsSync(scene.path) && scene.bytes > 5000,
        `${scene.path ?? r.text.split("\n")[0]} · ${scene.bytes} B · ${r.ms}ms`,
      );

      r = await call(client, "generate_speech", {
        model: "drama-3",
        text: "I'm fine. Really. <whisper>Go on without me.</whisper>",
        instructions: "barely holding it together, forcing a smile",
        format: "wav",
        output: "tts/direction.wav",
      });
      const directed = r.result.structuredContent ?? {};
      check(
        "drama-3 with instructions → wav",
        !r.result.isError && directed.mime_type === "audio/wav" && directed.duration_s > 1,
        `${directed.path ?? r.text.split("\n")[0]} · ${directed.duration_s}s`,
      );

      r = await call(client, "list_speech_models", { query: "Delia" });
      check(
        "list_speech_models lists your voices and library matches",
        r.text.includes("Your voices (") && /Library voices matching "Delia" \([1-9]/.test(r.text),
        r.text
          .split("\n")
          .filter((line) => /voices/i.test(line))
          .join(" | "),
      );
    } else {
      r = await call(client, "generate_speech", { text: "Hi", model: "nope/not-a-model" });
      check("unknown model → error", r.result.isError && /^[A-Z_]+: /.test(r.text), r.text.split("\n")[0]);
    }

    r = await call(client, "generate_speech", { file: "missing.md" });
    check("missing file → BAD_INPUT", r.result.isError && r.text.startsWith("BAD_INPUT"), r.text.split("\n")[0]);
  } finally {
    await client.close();
  }
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(
  path.join(WORK, "notes.md"),
  "Release 3.2 highlights:\n- Image tool accepts multiple inputs.\n- Retries honour Retry-After.\n- Breaking: output paths resolve against the workspace.\n",
);
writeFileSync(path.join(WORK, "red.png"), solidPng(64, [220, 20, 20]));

const started = Date.now();
if (!only || only === "txt") await testTxt();
if (!only || only === "img") await testImg();
if (!only || only === "tts") await testTts();
console.log(
  `\n${tally.pass} passed · ${tally.fail} failed · ${tally.blocked} blocked · ${((Date.now() - started) / 1000).toFixed(1)}s · output in ${path.relative(ROOT, WORK)}/`,
);
process.exit(tally.fail > 0 ? 1 : tally.blocked > 0 ? 3 : 0);
