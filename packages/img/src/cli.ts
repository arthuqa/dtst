#!/usr/bin/env node
/**
 * `img` CLI.
 *
 * A scriptable wrapper around the same operations the MCP tools use:
 *   img generate "a red panda astronaut" --out-dir out --json
 *   img edit "make it watercolour" -i out/red-panda.png --out out/water.png
 *   img models --query gemini
 *   img config
 *   img serve                       # MCP stdio server (also the no-argument mode)
 *
 * Results go to stdout, diagnostics to stderr.
 */

import {
  ArtifactStore,
  type CliCommandSpec,
  type CliValues,
  type CliValue,
  type Logger,
  type ProgressReporter,
  applyGlobalEnv,
  configSummary,
  createLogger,
  loadConfig,
  packageName,
  packageVersion,
  runCli,
} from "@dtst/internal";
import { listImageModels } from "./backends/select";
import { imgErrors } from "./errors";
import {
  runEdit,
  runGenerate,
  type EditOperationInput,
  type GenerateOperationInput,
  type OperationContext,
  type OperationOutcome,
} from "./operations";
import { runImgServer } from "./server";

applyGlobalEnv();

const NAME = packageName();
const VERSION = packageVersion();

/** Progress on stderr only: stdout may be piped into another tool. */
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
      process.stderr.write(`[img] ${counter}${message ?? ""}\n`);
    },
    async done() {
      // No trailing newline needed; each report already ends with one.
    },
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

function printOutcome(outcome: OperationOutcome, json: boolean, out: (line: string) => void, log: Logger): void {
  if (json) {
    out(JSON.stringify({ ok: true, ...outcome.structured }, null, 2));
    return;
  }
  const paths = outcome.images.map((image) => image.path).filter((value): value is string => typeof value === "string");
  if (paths.length === 0) {
    out(outcome.summary);
  } else {
    for (const path of paths) out(path);
  }
  for (const note of outcome.notes) log.info(note);
}

function stringValue(values: CliValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(values: CliValues, key: string): number | undefined {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pick<T extends string>(values: CliValues, key: string, allowed: readonly T[]): T | undefined {
  const value = stringValue(values, key);
  if (value === undefined) return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

type OutputFields = Pick<GenerateOperationInput, "output_path" | "output_dir" | "filename" | "overwrite" | "save" | "inline">;

function outputFields(values: CliValues): OutputFields {
  const out = stringValue(values, "out");
  const outDir = stringValue(values, "out-dir");
  const filename = stringValue(values, "filename");
  return {
    ...(out === undefined ? {} : { output_path: out }),
    ...(outDir === undefined ? {} : { output_dir: outDir }),
    ...(filename === undefined ? {} : { filename }),
    ...(values["overwrite"] === true ? { overwrite: true } : {}),
    ...(values["no-save"] === true ? { save: false } : {}),
    ...(values["no-inline"] === true ? { inline: false } : {}),
  };
}

function generationFields(values: CliValues): Omit<GenerateOperationInput, "prompt" | "n"> {
  const model = stringValue(values, "model");
  const size = stringValue(values, "size");
  const aspectRatio = stringValue(values, "aspect-ratio");
  const resolution = stringValue(values, "resolution");
  const quality = stringValue(values, "quality");
  const format = pick(values, "format", ["png", "jpeg", "webp"] as const);
  const background = pick(values, "background", ["transparent", "opaque", "auto"] as const);
  const compression = numberValue(values, "compression");
  const seed = numberValue(values, "seed");
  const style = stringValue(values, "style");
  const negative = stringValue(values, "negative-prompt");
  const user = stringValue(values, "user");
  return {
    ...(model === undefined ? {} : { model }),
    ...(size === undefined ? {} : { size }),
    ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(quality === undefined ? {} : { quality }),
    ...(format === undefined ? {} : { output_format: format }),
    ...(background === undefined ? {} : { background }),
    ...(compression === undefined ? {} : { output_compression: compression }),
    ...(seed === undefined ? {} : { seed }),
    ...(style === undefined ? {} : { style }),
    ...(negative === undefined ? {} : { negative_prompt: negative }),
    ...(user === undefined ? {} : { user }),
  };
}

const SHARED_OPTIONS = [
  { name: "model", alias: "m", type: "string" as const, description: "Image model id (default: DTST_IMAGE_MODEL, else OPENAI_MODEL).", placeholder: "model" },
  { name: "n", type: "number" as const, description: "How many images to produce (1-10).", placeholder: "count" },
  { name: "size", type: "string" as const, description: 'Explicit size ("1024x1024") or an OpenRouter tier ("2K").', placeholder: "size" },
  { name: "aspect-ratio", type: "string" as const, description: 'Aspect ratio such as "16:9".', placeholder: "ratio" },
  { name: "resolution", type: "string" as const, description: "Resolution tier where the provider takes one.", placeholder: "tier" },
  { name: "quality", type: "string" as const, description: "low|medium|high|xhigh|max|auto.", placeholder: "quality" },
  { name: "format", type: "string" as const, description: "png|jpeg|webp.", placeholder: "format" },
  { name: "background", type: "string" as const, description: "transparent|opaque|auto.", placeholder: "mode" },
  { name: "compression", type: "number" as const, description: "0-100 output compression for jpeg/webp.", placeholder: "0-100" },
  { name: "seed", type: "number" as const, description: "Seed for reproducible output (provider permitting).", placeholder: "seed" },
  { name: "style", type: "string" as const, description: "Style guidance appended to the prompt.", placeholder: "style" },
  { name: "negative-prompt", type: "string" as const, description: "Things to avoid.", placeholder: "text" },
  { name: "user", type: "string" as const, description: "Opaque end-user identifier forwarded to the provider.", placeholder: "id" },
  { name: "out", type: "string" as const, description: "Exact file or directory to write to.", placeholder: "path" },
  { name: "out-dir", type: "string" as const, description: "Directory to write into.", placeholder: "dir" },
  { name: "filename", type: "string" as const, description: "Preferred file name (extension added automatically).", placeholder: "name" },
  { name: "overwrite", type: "boolean" as const, description: "Replace an existing file instead of adding -1, -2 suffixes." },
  { name: "no-save", type: "boolean" as const, description: "Do not write to disk (prints the summary instead)." },
  { name: "no-inline", type: "boolean" as const, description: "Skip base64 previews in --json output." },
] as const;

const generateCommand: CliCommandSpec = {
  name: "generate",
  summary: "Generate image(s) from a prompt and save them to disk.",
  positionals: [{ name: "prompt", required: true, description: "What to draw." }],
  options: [...SHARED_OPTIONS],
  examples: [
    'img generate "a red panda astronaut, studio lighting" --out-dir out',
    'img generate "isometric icon set" --n 4 --size 1024x1024 --json',
  ],
  async run({ values, positionals, out, json, log }) {
    const prompt = positionals.join(" ").trim();
    if (!prompt) throw imgErrors.missingPrompt();
    const input: GenerateOperationInput = {
      ...generationFields(values),
      ...outputFields(values),
      prompt,
      n: numberValue(values, "n") ?? 1,
    };
    const outcome = await runGenerate(input, operationContext(values, log));
    printOutcome(outcome, json, out, log);
    return 0;
  },
};

const editCommand: CliCommandSpec = {
  name: "edit",
  summary: "Edit existing image(s) with a text instruction.",
  positionals: [{ name: "prompt", required: true, description: "The change to apply." }],
  options: [
    {
      name: "image",
      alias: "i",
      type: "string",
      multiple: true,
      required: true,
      description: "Input image (path, glob, URL, data URL or dtst:// artifact). Repeatable.",
      placeholder: "source",
    },
    { name: "mask", type: "string", description: "Mask image (images/edit backends only).", placeholder: "path" },
    { name: "input-fidelity", type: "string", description: "high|low — how strongly to preserve the input.", placeholder: "fidelity" },
    ...SHARED_OPTIONS,
  ],
  examples: [
    'img edit "make it snow" -i out/panda.webp --out out/panda-snow.webp',
    'img edit "add a hat" -i "shots/*.png" --out-dir out',
  ],
  async run({ values, positionals, out, json, log }) {
    const prompt = positionals.join(" ").trim();
    if (!prompt) throw imgErrors.missingPrompt();
    const raw = values["image"];
    const images = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
    if (images.length === 0) throw imgErrors.needsInputImages();
    const fidelity = pick(values, "input-fidelity", ["high", "low"] as const);
    const mask = stringValue(values, "mask");
    const input: EditOperationInput = {
      ...generationFields(values),
      ...outputFields(values),
      prompt,
      images,
      n: numberValue(values, "n") ?? 1,
      ...(mask === undefined ? {} : { mask }),
      ...(fidelity === undefined ? {} : { input_fidelity: fidelity }),
    };
    const outcome = await runEdit(input, operationContext(values, log));
    printOutcome(outcome, json, out, log);
    return 0;
  },
};

const modelsCommand: CliCommandSpec = {
  name: "models",
  summary: "List the image models the configured endpoint offers.",
  options: [
    { name: "query", alias: "q", type: "string", description: "Substring filter over model id, name or description.", placeholder: "text" },
    { name: "limit", type: "number", description: "Maximum results (default 50).", placeholder: "count" },
    { name: "backend", type: "string", description: "Force a protocol: auto|images|openrouter|chat.", placeholder: "kind" },
  ],
  examples: ["img models --query gemini --limit 20", "img models --json"],
  async run({ values, out, json, log }) {
    const config = loadConfig();
    const forcedBackend = pick(values, "backend", ["auto", "images", "openrouter", "chat"] as const);
    const effective = forcedBackend && forcedBackend !== "auto" ? { ...config, imageBackend: forcedBackend } : config;
    const result = await listImageModels(
      effective,
      { query: stringValue(values, "query"), limit: numberValue(values, "limit") ?? 50 },
      { log, signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)), progress: cliProgress(false) },
    );
    if (json) {
      out(
        JSON.stringify(
          { ok: true, backend: result.backend, ...(result.note === undefined ? {} : { note: result.note }), models: result.models },
          null,
          2,
        ),
      );
      return;
    }
    out(`backend: ${result.backend}`);
    if (result.note) out(`note: ${result.note}`);
    for (const model of result.models) {
      const modalities = model.outputModalities?.length ? ` [${model.outputModalities.join("+")}]` : "";
      const providers =
        model.endpointCount === undefined
          ? ""
          : model.endpointCount > 0
            ? ` (${model.endpointCount} provider(s) listed)`
            : " (no providers listed; may still work)";
      out(`${model.id}${modalities}${providers}`);
    }
  },
};

const configCommand: CliCommandSpec = {
  name: "config",
  summary: "Print the effective configuration (secrets redacted).",
  options: [],
  examples: ["img config"],
  async run({ out }) {
    out(JSON.stringify(configSummary(loadConfig()), null, 2));
  },
};

const log = createLogger("img");

await runCli({
  binName: "img",
  version: VERSION,
  summary: `Image generation and editing, MCP server + CLI (${NAME})`,
  description: [
    "With no arguments (or `img serve`) this starts an MCP stdio server;",
    "in an interactive terminal with no arguments it prints the help instead.",
    "Configuration comes from the environment or the nearest .env file.",
  ].join("\n"),
  commands: [generateCommand, editCommand, modelsCommand, configCommand],
  serve: async () => {
    await runImgServer({ log });
  },
  env: [
    { name: "OPENAI_BASE_URL", description: "API root of any OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1", required: true },
    { name: "OPENAI_API_KEY", description: "Bearer token. Optional for localhost endpoints unless DTST_ALLOW_NO_API_KEY=0.", required: true },
    { name: "OPENAI_MODEL", description: "Model used for images (and shared with @dtst/txt for text)." },
    { name: "DTST_IMAGE_MODEL", description: "Optional override when images come from a different model than OPENAI_MODEL." },
    { name: "DTST_IMG_BACKEND", description: "auto (default) | images | openrouter | chat — force a wire protocol." },
    { name: "DTST_WORKSPACE", description: "Root for relative output paths (default: process cwd)." },
    { name: "DTST_OUTPUT_DIR", description: "Default directory for generated files." },
    { name: "DTST_ALLOWED_WRITE_ROOTS", description: "Colon-separated allow-list; when set, writes outside it are refused." },
    { name: "DTST_TIMEOUT_MS", description: "Per-request timeout in ms (default 600000)." },
    { name: "DTST_MAX_RETRIES", description: "Retries for 408/409/429/5xx (default 2)." },
    { name: "DTST_EXTRA_HEADERS", description: "JSON object merged into every request (provider knobs)." },
    { name: "DTST_EXTRA_BODY", description: "JSON object merged into every request body." },
    { name: "DTST_LOG_LEVEL", description: "silent | error | warn | info | debug (default warn). stderr only." },
    { name: "DTST_ENV_FILE", description: "Explicit .env file to load instead of walking up from cwd." },
  ],
  defaults: [
    { name: "backend", value: "auto", description: "Chooses images / openrouter / chat from the host and model." },
    { name: "n", value: "1", description: "Images per call." },
    { name: "inline", value: "true", description: "Include image bytes in the MCP response (budget: 4 images / 8 MiB)." },
    { name: "overwrite", value: "false", description: "Existing files get a -1, -2, … suffix instead of being replaced." },
  ],
});

export type { CliValue };
