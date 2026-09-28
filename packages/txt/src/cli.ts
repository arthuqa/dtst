#!/usr/bin/env node
/**
 * `txt` CLI.
 *
 *   txt write "Summarise RELEASE.md in five bullets" --context RELEASE.md
 *   txt write "Describe these screenshots" -i "shots/*.png" --format markdown --out-dir out
 *   txt chat "Continue the plan" --messages '[{"role":"user","content":"..."}]'
 *   txt read src/*.ts --json
 *   txt models --query luna
 *   txt config
 *   txt serve                       # MCP stdio server (also the no-argument mode)
 *
 * Results go to stdout, diagnostics to stderr.
 */

import {
  ArtifactStore,
  type CliCommandSpec,
  type CliValues,
  type Logger,
  type ProgressReporter,
  applyGlobalEnv,
  configSummary,
  createLogger,
  gatherContext,
  loadConfig,
  packageName,
  packageVersion,
  runCli,
} from "@dtst/internal";
import { describeModel, listModels } from "./models";
import { runChat, runWriteText, type ChatInput, type OperationContext, type TextOutcome, type WriteTextInput } from "./operations";
import type { OutputFormat, Verbosity } from "./prompt";
import { runTxtServer } from "./server";

applyGlobalEnv();

const NAME = packageName();
const VERSION = packageVersion();

function cliProgress(enabled: boolean): ProgressReporter {
  let last = 0;
  return {
    enabled,
    async report(progress, total, message) {
      if (!enabled) return;
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      const counter = total && total > 1 ? `${Math.min(Math.max(0, Math.round(progress)), total)}/${total} ` : "";
      process.stderr.write(`[txt] ${counter}${message ?? ""}\n`);
    },
    async done() {},
  };
}

function operationContext(values: CliValues, log: Logger): OperationContext {
  const config = loadConfig();
  return {
    config,
    log,
    progress: cliProgress(values["quiet"] !== true && process.stderr.isTTY === true),
    signal: AbortSignal.timeout(config.timeoutMs),
    artifacts: new ArtifactStore(),
  };
}

function stringValue(values: CliValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(values: CliValues, key: string): number | undefined {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(values: CliValues, key: string): string[] {
  const value = values[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function pick<T extends string>(values: CliValues, key: string, allowed: readonly T[]): T | undefined {
  const value = stringValue(values, key);
  return value !== undefined && allowed.includes(value as T) ? (value as T) : undefined;
}

function printOutcome(outcome: TextOutcome, json: boolean, out: (line: string) => void, log: Logger): void {
  if (json) {
    out(JSON.stringify({ ok: true, ...outcome.structured }, null, 2));
  } else {
    out(outcome.text);
    for (const note of outcome.notes) log.warn(note);
  }
  if (outcome.saved) log.info(`saved ${outcome.saved.path}`);
  if (outcome.usage?.totalTokens !== undefined) {
    log.debug(
      `usage: in ${outcome.usage.inputTokens ?? "?"} out ${outcome.usage.outputTokens ?? "?"} total ${outcome.usage.totalTokens}${
        outcome.usage.costUsd === undefined ? "" : ` cost $${outcome.usage.costUsd.toFixed(6)}`
      }`,
    );
  }
}

type SaveFields = Pick<WriteTextInput, "output_path" | "output_dir" | "filename" | "overwrite" | "save">;

function saveFields(values: CliValues): SaveFields {
  const out = stringValue(values, "out");
  const outDir = stringValue(values, "out-dir");
  const filename = stringValue(values, "filename");
  return {
    ...(out === undefined ? {} : { output_path: out }),
    ...(outDir === undefined ? {} : { output_dir: outDir }),
    ...(filename === undefined ? {} : { filename }),
    ...(values["overwrite"] === true ? { overwrite: true } : {}),
    ...(values["no-save"] === true ? { save: false } : {}),
  };
}

type SamplingFields = Pick<
  WriteTextInput,
  "model" | "system" | "max_tokens" | "temperature" | "top_p" | "stop" | "reasoning_effort" | "format" | "verbosity" | "stream"
>;

function samplingFields(values: CliValues): SamplingFields {
  const model = stringValue(values, "model");
  const system = stringValue(values, "system");
  const maxTokens = numberValue(values, "max-tokens");
  const temperature = numberValue(values, "temperature");
  const topP = numberValue(values, "top-p");
  const reasoning = stringValue(values, "reasoning-effort");
  const format = pick<OutputFormat>(values, "format", ["text", "markdown", "json"]);
  const verbosity = pick<Verbosity>(values, "verbosity", ["concise", "balanced", "detailed"]);
  return {
    ...(model === undefined ? {} : { model }),
    ...(system === undefined ? {} : { system }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(reasoning === undefined ? {} : { reasoning_effort: reasoning }),
    ...(format === undefined ? {} : { format }),
    ...(verbosity === undefined ? {} : { verbosity }),
    ...(values["stream"] === true ? { stream: true } : {}),
  };
}

const SAMPLING_OPTIONS = [
  { name: "model", alias: "m", type: "string" as const, description: "Model id (default: OPENAI_MODEL).", placeholder: "model" },
  { name: "system", type: "string" as const, description: "Extra system-level guidance.", placeholder: "text" },
  { name: "max-tokens", type: "number" as const, description: "Upper bound on generated tokens.", placeholder: "count" },
  { name: "temperature", type: "number" as const, description: "Sampling temperature (0-2).", placeholder: "0-2" },
  { name: "top-p", type: "number" as const, description: "Nucleus sampling probability mass (0-1).", placeholder: "0-1" },
  { name: "reasoning-effort", type: "string" as const, description: "low|medium|high, for models that support it.", placeholder: "level" },
  { name: "format", type: "string" as const, description: "text|markdown|json.", placeholder: "format" },
  { name: "verbosity", type: "string" as const, description: "concise|balanced|detailed.", placeholder: "level" },
  { name: "stream", type: "boolean" as const, description: "Stream tokens and report progress (slower start, live progress)." },
] as const;

const SAVE_OPTIONS = [
  { name: "out", type: "string" as const, description: "Exact file or directory to write the result to.", placeholder: "path" },
  { name: "out-dir", type: "string" as const, description: "Directory to write into.", placeholder: "dir" },
  { name: "filename", type: "string" as const, description: "Preferred file name (extension from --format).", placeholder: "name" },
  { name: "overwrite", type: "boolean" as const, description: "Replace an existing file instead of adding -1, -2 suffixes." },
  { name: "no-save", type: "boolean" as const, description: "Never write to disk." },
] as const;

const writeCommand: CliCommandSpec = {
  name: "write",
  summary: "Write text from instructions, optional source material and context.",
  positionals: [{ name: "instructions", required: true, description: "The writing task." }],
  options: [
    { name: "input", type: "string" as const, description: "Inline source material to transform.", placeholder: "text" },
    { name: "input-file", type: "string" as const, description: "Read the source material from a file (or a glob).", placeholder: "path" },
    { name: "context", type: "string" as const, multiple: true, description: "Context source: file, glob, directory, URL or dtst:// artifact. Repeatable.", placeholder: "source" },
    { name: "image", alias: "i", type: "string" as const, multiple: true, description: "Image for vision models (path, glob, URL, data URL). Repeatable.", placeholder: "source" },
    ...SAMPLING_OPTIONS,
    ...SAVE_OPTIONS,
  ],
  examples: [
    'txt write "Summarise these release notes in 5 bullets" --context RELEASE.md',
    'txt write "Extract the totals" -i "invoices/*.png" --format json --out totals.json',
  ],
  async run({ values, positionals, out, json, log }) {
    const instructions = positionals.join(" ").trim();
    if (!instructions) throw new Error("Missing writing instructions.");
    const inputFile = stringValue(values, "input-file");
    const inlineInput = stringValue(values, "input");

    let input = inlineInput;
    if (inputFile) {
      const gathered = await gatherContext({ files: [inputFile] }, { root: loadConfig().workspaceRoot });
      input = gathered.chunks.map((chunk) => chunk.text).join("\n\n") || input;
    }
    const contextSources = arrayValue(values, "context");
    const images = arrayValue(values, "image");
    const request: WriteTextInput = {
      instructions,
      ...(input === undefined ? {} : { input }),
      ...(contextSources.length === 0 ? {} : { context: { files: contextSources } }),
      ...(images.length === 0 ? {} : { images }),
      ...samplingFields(values),
      ...saveFields(values),
    };
    const outcome = await runWriteText(request, operationContext(values, log));
    printOutcome(outcome, json, out, log);
    return 0;
  },
};

const chatCommand: CliCommandSpec = {
  name: "chat",
  summary: "Send a chat completion (single message or a full message history).",
  positionals: [{ name: "message", required: true, description: "The user message to send." }],
  options: [
    { name: "messages", type: "string" as const, description: 'Full conversation as JSON: [{"role":"user","content":"…"}].', placeholder: "json" },
    { name: "image", alias: "i", type: "string" as const, multiple: true, description: "Image for the last user turn. Repeatable.", placeholder: "source" },
    ...SAMPLING_OPTIONS,
    ...SAVE_OPTIONS,
  ],
  examples: [
    'txt chat "Reply with exactly: PONG" --json',
    `txt chat "And the second one?" --messages '[{"role":"user","content":"Name a planet"},{"role":"assistant","content":"Mars"}]'`,
  ],
  async run({ values, positionals, out, json, log }) {
    const rawMessages = stringValue(values, "messages");
    let messages: ChatInput["messages"];
    if (rawMessages) {
      const parsed: unknown = JSON.parse(rawMessages);
      if (!Array.isArray(parsed)) throw new Error("--messages must be a JSON array of {role, content} objects.");
      messages = parsed.map((entry) => {
        const record = entry as { role?: unknown; content?: unknown };
        const role = typeof record.role === "string" && ["system", "user", "assistant"].includes(record.role) ? record.role : "user";
        return { role: role as "system" | "user" | "assistant", content: String(record.content ?? "") };
      });
    } else {
      messages = [{ role: "user", content: positionals.join(" ").trim() }];
    }
    const images = arrayValue(values, "image");
    const request: ChatInput = {
      messages,
      ...(images.length === 0 ? {} : { images }),
      ...samplingFields(values),
      ...saveFields(values),
    };
    const outcome = await runChat(request, operationContext(values, log));
    printOutcome(outcome, json, out, log);
    return 0;
  },
};

const readCommand: CliCommandSpec = {
  name: "read",
  summary: "Read files, globs, directories or URLs and print them.",
  positionals: [{ name: "sources", description: "File paths, globs or URLs." }],
  options: [
    { name: "dir", type: "string" as const, multiple: true, description: "Directories to read (non-recursive). Repeatable.", placeholder: "dir" },
    { name: "url", type: "string" as const, multiple: true, description: "URLs to fetch. Repeatable.", placeholder: "url" },
    { name: "artifact", type: "string" as const, multiple: true, description: "dtst:// artifact URIs. Repeatable.", placeholder: "uri" },
    { name: "max-bytes", type: "number" as const, description: "Per-source byte budget (default 262144).", placeholder: "bytes" },
    { name: "max-total-bytes", type: "number" as const, description: "Total byte budget (default 1048576).", placeholder: "bytes" },
  ],
  examples: ["txt read src/index.ts README.md", 'txt read "docs/*.md" --json'],
  async run({ values, positionals, out, json, log }) {
    const config = loadConfig();
    const result = await gatherContext(
      {
        files: positionals,
        dirs: arrayValue(values, "dir"),
        urls: arrayValue(values, "url"),
        artifacts: arrayValue(values, "artifact"),
      },
      {
        root: config.workspaceRoot,
        ...(numberValue(values, "max-bytes") === undefined ? {} : { maxPerSourceBytes: numberValue(values, "max-bytes") }),
        ...(numberValue(values, "max-total-bytes") === undefined ? {} : { maxTotalBytes: numberValue(values, "max-total-bytes") }),
      },
    );
    if (json) {
      out(
        JSON.stringify(
          {
            ok: true,
            totalBytes: result.totalBytes,
            truncated: result.truncated,
            chunks: result.chunks,
            images: result.images.map((image) => ({
              source: image.source,
              mimeType: image.mimeType,
              bytes: image.bytes,
              ...(image.width === undefined ? {} : { width: image.width }),
              ...(image.height === undefined ? {} : { height: image.height }),
            })),
            skipped: result.skipped,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (result.chunks.length === 0 && result.images.length === 0) {
      log.warn("nothing was read");
    }
    for (const chunk of result.chunks) {
      out(`--- ${chunk.label} (${chunk.source})${chunk.truncated ? " [truncated]" : ""} ---`);
      out(chunk.text);
      out("");
    }
    for (const image of result.images) {
      out(`--- image: ${image.label ?? image.source} (${image.mimeType}, ${image.bytes} bytes) ---`);
    }
    for (const skip of result.skipped) log.warn(`skipped ${skip.source}: ${skip.reason}`);
  },
};

const modelsCommand: CliCommandSpec = {
  name: "models",
  summary: "List the models the configured endpoint offers.",
  options: [
    { name: "query", alias: "q", type: "string", description: "Substring filter over model ids and names.", placeholder: "text" },
    { name: "limit", type: "number", description: "Maximum results (default 100).", placeholder: "count" },
    { name: "vision", type: "boolean", description: "Only models that accept images." },
  ],
  examples: ["txt models --query luna", "txt models --vision --limit 20"],
  async run({ values, out, json, log }) {
    const config = loadConfig();
    const { models, total } = await listModels(
      config,
      { query: stringValue(values, "query"), limit: numberValue(values, "limit") ?? 100 },
      { signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)) },
    );
    const filtered = values["vision"] === true ? models.filter((model) => model.inputModalities?.includes("image")) : models;
    if (json) {
      out(JSON.stringify({ ok: true, endpoint: config.baseUrl, defaultModel: config.textModel ?? null, total, models: filtered }, null, 2));
      return;
    }
    out(`endpoint: ${config.baseUrl}`);
    out(`default model: ${config.textModel ?? "(OPENAI_MODEL is not set)"}`);
    for (const model of filtered) out(describeModel(model));
    log.debug(`${filtered.length} of ${total} models shown`);
  },
};

const configCommand: CliCommandSpec = {
  name: "config",
  summary: "Print the effective configuration (secrets redacted).",
  options: [],
  examples: ["txt config"],
  async run({ out }) {
    out(JSON.stringify(configSummary(loadConfig()), null, 2));
  },
};

const log = createLogger("txt");

await runCli({
  binName: "txt",
  version: VERSION,
  summary: `Writing, context and vision, MCP server + CLI (${NAME})`,
  description: [
    "With no arguments (or `txt serve`) this starts an MCP stdio server;",
    "in an interactive terminal with no arguments it prints the help instead.",
    "Configuration comes from the environment or the nearest .env file.",
  ].join("\n"),
  commands: [writeCommand, chatCommand, readCommand, modelsCommand, configCommand],
  serve: async () => {
    await runTxtServer({ log });
  },
  env: [
    { name: "OPENAI_BASE_URL", description: "API root of any OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1", required: true },
    { name: "OPENAI_API_KEY", description: "Bearer token. Optional for localhost endpoints unless DTST_ALLOW_NO_API_KEY=0.", required: true },
    { name: "OPENAI_MODEL", description: "Default text model for every call." },
    { name: "DTST_TXT_API", description: "chat (default) | responses — which API surface to use." },
    { name: "DTST_WORKSPACE", description: "Root for relative paths (default: process cwd)." },
    { name: "DTST_OUTPUT_DIR", description: "Default directory for saved results." },
    { name: "DTST_ALLOWED_WRITE_ROOTS", description: "Colon-separated allow-list; when set, writes outside it are refused." },
    { name: "DTST_TIMEOUT_MS", description: "Per-request timeout in ms (default 600000)." },
    { name: "DTST_MAX_RETRIES", description: "Retries for 408/409/429/5xx (default 2)." },
    { name: "DTST_MAX_IMAGE_BYTES", description: "Largest accepted input image (default 26214400)." },
    { name: "DTST_MAX_IMAGES", description: "Maximum images per call (default 16)." },
    { name: "DTST_EXTRA_HEADERS", description: "JSON object merged into every request (provider knobs)." },
    { name: "DTST_EXTRA_BODY", description: "JSON object merged into every request body." },
    { name: "DTST_LOG_LEVEL", description: "silent | error | warn | info | debug (default warn). stderr only." },
    { name: "DTST_ENV_FILE", description: "Explicit .env file to load instead of walking up from cwd." },
  ],
  defaults: [
    { name: "text api", value: "chat", description: "Falls back to chat automatically if the endpoint rejects /responses." },
    { name: "verbosity", value: "balanced", description: "concise | balanced | detailed." },
    { name: "save", value: "false", description: "Text is returned inline unless a destination or --out is given." },
    { name: "context budget", value: "256 KiB/source, 1 MiB total", description: "Raise with --max-bytes / --max-total-bytes." },
  ],
});
