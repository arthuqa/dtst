/**
 * CLI framework shared by `img` and `txt`.
 *
 * Each package is two things in one executable:
 *   - an MCP stdio server (no arguments, or `serve`), and
 *   - a normal CLI (`generate`, `write`, `models`, ...) so the same logic can
 *     be used, scripted and tested without an MCP client.
 *
 * Convention: results go to stdout, diagnostics go to stderr. That matters
 * because stdout doubles as the JSON-RPC channel in server mode.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { configError, isDtstError, toDtstError } from "./errors";
import { type Logger, createLogger, registerSecret, setLogLevel } from "./log";

export interface CliOptionSpec {
  name: string;
  alias?: string;
  type: "string" | "boolean" | "number";
  description: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  choices?: readonly string[];
}

export interface CliPositionalSpec {
  name: string;
  required?: boolean;
  description: string;
}

export interface CliCommandSpec {
  name: string;
  summary: string;
  positionals?: readonly CliPositionalSpec[];
  options?: readonly CliOptionSpec[];
  examples?: readonly string[];
  run: (args: CliRunArgs) => Promise<number | void>;
}

export interface CliRunArgs {
  values: CliValues;
  positionals: string[];
  log: Logger;
  /** Write a line to stdout. */
  out: (line: string) => void;
  json: boolean;
  /** True when the caller asked for verbose diagnostics. */
  debug: boolean;
}

export type CliValue = string | number | boolean | string[] | number[] | undefined;
export type CliValues = Record<string, CliValue>;

export interface CliSpec {
  binName: string;
  version: string;
  summary: string;
  description?: string;
  commands: readonly CliCommandSpec[];
  /** Start the MCP stdio server. */
  serve: () => Promise<void>;
  env?: readonly { name: string; description: string; required?: boolean }[];
  defaults?: readonly { name: string; value: string; description: string }[];
}

export class CliUsageError extends Error {}

const GLOBAL_OPTIONS: readonly CliOptionSpec[] = [
  { name: "help", alias: "h", type: "boolean", description: "Show help and exit." },
  { name: "version", alias: "v", type: "boolean", description: "Print the version and exit." },
  { name: "json", type: "boolean", description: "Emit machine-readable JSON on stdout." },
  { name: "debug", type: "boolean", description: "Verbose diagnostics on stderr (sets DTST_LOG_LEVEL=debug)." },
  { name: "quiet", alias: "q", type: "boolean", description: "Only errors on stderr." },
  { name: "env-file", type: "string", description: "Load configuration from this .env file.", placeholder: "path" },
];

export async function runCli(spec: CliSpec): Promise<void> {
  const argv = process.argv.slice(2);
  const log = createLogger(spec.binName);

  try {
    await dispatch(spec, argv, log);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    reportError(error, log, argv.includes("--json"));
    process.exitCode = 1;
  }
}

/**
 * Find the first token that names a command, skipping global flags and the
 * values they consume, so `img --debug` behaves like `img`.
 */
function commandTokenIndex(argv: readonly string[]): number {
  const valueFlags = new Set(["--env-file"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token.startsWith("--")) {
      if (valueFlags.has(token)) index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) continue;
    return index;
  }
  return -1;
}

async function dispatch(spec: CliSpec, argv: string[], log: Logger): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${spec.binName} ${spec.version}\n`);
    return;
  }

  const commandIndex = commandTokenIndex(argv);
  const first = commandIndex >= 0 ? argv[commandIndex] : undefined;
  const helpFlag = argv.includes("--help") || argv.includes("-h");

  // No command at all: `--help`, no arguments, or only global flags.
  if (first === undefined) {
    // A human in a terminal (not an MCP client) almost never wants a stdio
    // server that waits for JSON-RPC, so show the help instead.
    if (helpFlag || process.stdin.isTTY) {
      process.stdout.write(`${renderHelp(spec)}\n`);
      if (!helpFlag) log.info(`no command given; run \`${spec.binName} serve\` to start the MCP stdio server`);
      return;
    }
    await spec.serve();
    return;
  }

  if (first === "serve" || first === "mcp" || first === "stdio") {
    await spec.serve();
    return;
  }

  if (first === "help") {
    process.stdout.write(`${renderHelp(spec)}\n`);
    return;
  }

  const command = spec.commands.find((entry) => entry.name === first);
  if (!command) {
    throw new CliUsageError(
      `Unknown command: ${first}\n\n${renderCommandList(spec)}\nRun \`${spec.binName} --help\` for details.`,
    );
  }

  const rest = argv.filter((_token, index) => index !== commandIndex);
  const { values, positionals } = parseCommandArgs(spec, command, rest, log);

  if (values["help"] === true) {
    process.stdout.write(`${renderCommandHelp(spec, command)}\n`);
    return;
  }

  const code = await command.run({
    values,
    positionals,
    log,
    out: (line: string) => process.stdout.write(`${line}\n`),
    json: values["json"] === true,
    debug: values["debug"] === true,
  });
  if (typeof code === "number") process.exitCode = code;
}

function parseCommandArgs(
  spec: CliSpec,
  command: CliCommandSpec,
  argv: string[],
  log: Logger,
): { values: CliValues; positionals: string[] } {
  const options = [...GLOBAL_OPTIONS, ...(command.options ?? [])];
  const argsOptions: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }> = {};
  const numeric = new Set<string>();
  const known = new Map<string, CliOptionSpec>();

  for (const option of options) {
    if (known.has(option.name)) continue;
    known.set(option.name, option);
    if (option.type === "number") numeric.add(option.name);
    const entry: { type: "string" | "boolean"; multiple?: boolean; short?: string } = {
      type: option.type === "boolean" ? "boolean" : "string",
    };
    if (option.multiple) entry.multiple = true;
    if (option.alias) entry.short = option.alias;
    argsOptions[option.name] = entry;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: argsOptions,
      allowPositionals: true,
      strict: true,
      tokens: false,
    });
  } catch (error) {
    throw new CliUsageError(`${(error as Error).message}\n\n${renderCommandHelp(spec, command)}`);
  }

  const values: CliValues = {};
  for (const [name, rawValue] of Object.entries(parsed.values as Record<string, unknown>)) {
    if (rawValue === undefined) continue;
    const option = known.get(name);
    if (option?.type === "number") {
      values[name] = Array.isArray(rawValue)
        ? rawValue.map((entry) => parseNumber(String(entry), name))
        : typeof rawValue === "string"
          ? parseNumber(rawValue, name)
          : undefined;
      continue;
    }
    if (Array.isArray(rawValue)) {
      values[name] = rawValue.map((entry) => String(entry));
      continue;
    }
    if (typeof rawValue === "string" || typeof rawValue === "boolean") values[name] = rawValue;
  }

  for (const [name, raw] of Object.entries(values)) {
    const option = known.get(name);
    if (!option) continue;
    if (option.choices && raw !== undefined) {
      const candidates = Array.isArray(raw) ? raw : [raw];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && !option.choices.includes(candidate)) {
          throw new CliUsageError(
            `Invalid value for --${name}: ${candidate}. Expected one of: ${option.choices.join(", ")}.`,
          );
        }
      }
    }
  }

  // `--help` must win over required-argument validation so that
  // `img generate --help` explains the command instead of complaining.
  const helpRequested = values["help"] === true;
  for (const option of options) {
    if (!helpRequested && option.required && values[option.name] === undefined) {
      throw new CliUsageError(`Missing required option --${option.name}.\n\n${renderCommandHelp(spec, command)}`);
    }
  }

  const positionals = parsed.positionals;
  const specs = command.positionals ?? [];
  for (const [index, positional] of specs.entries()) {
    if (!helpRequested && positional.required && positionals[index] === undefined) {
      throw new CliUsageError(`Missing required argument <${positional.name}>.\n\n${renderCommandHelp(spec, command)}`);
    }
  }
  if (positionals.length > specs.length && specs.length > 0) {
    log.warn("extra positional arguments ignored", { args: positionals.slice(specs.length).join(" ") });
  }

  return { values, positionals };
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliUsageError(`--${name} expects a number, got ${JSON.stringify(value)}.`);
  return parsed;
}

export function renderHelp(spec: CliSpec): string {
  const lines: string[] = [
    `${spec.binName} ${spec.version} — ${spec.summary}`,
    "",
    `Usage: ${spec.binName} <command> [options]`,
    `       ${spec.binName} serve            # MCP stdio server (what MCP clients run)`,
    `       ${spec.binName} --help`,
  ];
  if (spec.description) lines.push("", spec.description);

  lines.push("", "Commands:", ...renderCommandTable(spec));

  if (spec.env && spec.env.length > 0) {
    lines.push("", "Environment:");
    for (const entry of spec.env) {
      lines.push(`  ${entry.name}${entry.required ? " (required)" : ""}`);
      lines.push(`      ${entry.description}`);
    }
  }
  if (spec.defaults && spec.defaults.length > 0) {
    lines.push("", "Defaults:");
    for (const entry of spec.defaults) {
      lines.push(`  ${entry.name} = ${entry.value}`);
      lines.push(`      ${entry.description}`);
    }
  }
  lines.push("", `Run \`${spec.binName} <command> --help\` for command-specific options.`);
  return lines.join("\n");
}

function renderCommandTable(spec: CliSpec): string[] {
  const rows = [...spec.commands.map((command) => [command.name, command.summary] as const), ["serve", "Start the MCP stdio server."] as const];
  const width = Math.max(...rows.map(([name]) => name.length));
  return rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`);
}

function renderCommandList(spec: CliSpec): string {
  return ["Commands:", ...renderCommandTable(spec)].join("\n");
}

export function renderCommandHelp(spec: CliSpec, command: CliCommandSpec): string {
  const positionals = (command.positionals ?? []).map((entry) => (entry.required ? `<${entry.name}>` : `[${entry.name}]`));
  const lines = [
    `Usage: ${spec.binName} ${command.name} ${positionals.join(" ")} [options]`.replace(/ +$/, ""),
    "",
    command.summary,
    "",
    "Options:",
  ];
  for (const option of [...GLOBAL_OPTIONS, ...(command.options ?? [])]) {
    const flag = `--${option.name}${option.alias ? `, -${option.alias}` : ""}`;
    const value = option.type === "boolean" ? "" : ` <${option.placeholder ?? option.type}>`;
    lines.push(`  ${`${flag}${value}`.padEnd(34)} ${option.description}${option.required ? " (required)" : ""}${option.choices ? ` [${option.choices.join("|")}]` : ""}`);
  }
  if (command.positionals && command.positionals.length > 0) {
    lines.push("", "Arguments:");
    for (const entry of command.positionals) {
      lines.push(`  ${entry.name.padEnd(32)} ${entry.description}`);
    }
  }
  if (command.examples && command.examples.length > 0) {
    lines.push("", "Examples:");
    for (const example of command.examples) lines.push(`  ${example}`);
  }
  return lines.join("\n");
}

function reportError(error: unknown, log: Logger, json: boolean): void {
  const dtst = toDtstError(error);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: dtst.code,
            message: dtst.message,
            ...(dtst.hint === undefined ? {} : { hint: dtst.hint }),
            ...(dtst.status === undefined ? {} : { status: dtst.status }),
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  log.error(isDtstError(dtst) ? dtst.format() : String(error));
}

export interface StdioServerHandle {
  close(): Promise<void>;
}

/**
 * Run an MCP server over stdio with a clean lifecycle:
 * stdin EOF, SIGINT and SIGTERM all shut the server down before exiting.
 */
export async function serveStdio(
  create: () => Promise<StdioServerHandle>,
  info: { name: string; version: string },
  log: Logger = createLogger("mcp"),
): Promise<void> {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return; // client went away; the stdin handler will shut us down
    log.warn("stdout error", { message: error.message });
  });

  const handle = await create();
  let closing = false;
  const shutdown = async (reason: string, code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { reason });
    try {
      await handle.close();
    } catch (error) {
      log.debug("close failed", { error });
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.stdin.on("end", () => void shutdown("stdin end", 0));
  process.stdin.on("close", () => void shutdown("stdin close", 0));
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { message: error.message, stack: error.stack });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
    void shutdown("unhandledRejection", 1);
  });

  log.info(`${info.name} ${info.version} ready on stdio`);
}

/** Apply global CLI flags that must take effect before configuration loads. */
export function applyGlobalEnv(argv: string[] = process.argv.slice(2)): void {
  if (argv.includes("--debug")) setLogLevel("debug");
  else if (argv.includes("--quiet") || argv.includes("-q")) setLogLevel("error");
  const envFileIndex = argv.findIndex((entry) => entry === "--env-file");
  if (envFileIndex >= 0) {
    const value = argv[envFileIndex + 1];
    if (!value) throw new CliUsageError("--env-file requires a path.");
    process.env["DTST_ENV_FILE"] = path.resolve(value);
  }
}

/** Print a redacted view of the effective configuration. */
export function configToJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

export function requireConfigValue<T>(value: T | undefined, name: string, hint?: string): T {
  if (value === undefined) {
    throw configError(`${name} is not configured.`, hint);
  }
  return value;
}

export { registerSecret, setLogLevel };
