/** MCP plumbing shared by both servers: tool registration, errors, progress, workspace root, stdio. */

import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolResult,
  type ContentBlock,
  type ServerNotification,
  type ToolAnnotations,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { type Config, loadDotEnv, readConfig } from "./config";
import { resolvePath } from "./files";
import { toDtstError } from "./errors";
import { log, redact } from "./log";

export interface ToolContext {
  config: Config;
  /** Directory relative paths resolve against. */
  root: string;
  signal: AbortSignal;
  /** Report progress (also keeps client timeouts alive). No-op if the client did not ask for it. */
  progress(message: string): Promise<void>;
}

export interface ToolSpec<In extends z.ZodRawShape, Out extends z.ZodRawShape> {
  title: string;
  description: string;
  input: In;
  output?: Out;
  annotations: ToolAnnotations;
}

type Extra = RequestHandlerExtra<never, ServerNotification>;

const HEARTBEAT_MS = 15_000;

export class Server {
  readonly mcp: McpServer;
  private config: Config | undefined;
  private clientRoot: string | undefined;

  constructor(info: { name: string; version: string }, instructions: string) {
    this.mcp = new McpServer(info, { instructions });
    this.mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      this.clientRoot = undefined;
    });
  }

  tool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
    name: string,
    spec: ToolSpec<In, Out>,
    handler: (args: z.output<z.ZodObject<In>>, context: ToolContext) => Promise<CallToolResult>,
  ): void {
    const callback = async (args: z.output<z.ZodObject<In>>, extra: Extra): Promise<CallToolResult> => {
      const token = extra._meta?.progressToken;
      let count = 0;
      const progress = async (message: string): Promise<void> => {
        if (token === undefined) return;
        count += 1; // MCP requires strictly increasing progress values
        await extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: count, message },
          })
          .catch(() => undefined);
      };
      const heartbeat = token === undefined ? undefined : setInterval(() => void progress("working…"), HEARTBEAT_MS);
      const started = Date.now();
      try {
        this.config ??= readConfig();
        const root = await this.root(this.config);
        const result = await handler(args, { config: this.config, root, signal: extra.signal, progress });
        log.debug(`${name} ok in ${Date.now() - started}ms`);
        return result;
      } catch (error) {
        const dtst = toDtstError(error);
        log.debug(`${name} failed in ${Date.now() - started}ms`, dtst.toString());
        return { isError: true, content: [text(redact(dtst.toString()))] };
      } finally {
        clearInterval(heartbeat);
      }
    };
    this.mcp.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        ...(spec.output ? { outputSchema: spec.output } : {}),
        annotations: spec.annotations,
      },
      callback as never,
    );
  }

  /** DTST_WORKSPACE, else the client's first root, else the working directory (home if that is `/`). */
  private async root(config: Config): Promise<string> {
    if (config.workspace) return resolvePath(config.workspace, process.cwd());
    if (this.clientRoot) return this.clientRoot;
    if (this.mcp.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await this.mcp.server.listRoots(undefined, { timeout: 5000 });
        const first = roots.find((root) => root.uri.startsWith("file://"));
        if (first) return (this.clientRoot = fileURLToPath(first.uri));
      } catch (error) {
        log.debug("roots/list failed", String(error));
      }
    }
    const cwd = process.cwd();
    return cwd === path.parse(cwd).root ? os.homedir() : cwd;
  }
}

export function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

export function image(data: Buffer, mimeType: string): ContentBlock {
  return { type: "image", data: data.toString("base64"), mimeType };
}

export function fileLink(file: string, mimeType: string, size: number): ContentBlock {
  return { type: "resource_link", uri: pathToFileURL(file).href, name: path.basename(file), mimeType, size };
}

/** Process entry point: `--help`, `--version`, otherwise serve MCP over stdio. */
export async function runStdio(
  create: () => Server,
  info: { name: string; version: string; help: string },
): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") return void process.stdout.write(`${info.help.trim()}\n`);
  if (arg === "--version" || arg === "-v") return void process.stdout.write(`${info.name} ${info.version}\n`);
  if (process.stdin.isTTY) log.warn(`${info.name} speaks MCP on stdio; add it to an MCP client (see --help).`);

  loadDotEnv();
  const server = create();
  await server.mcp.connect(new StdioServerTransport());
  const shutdown = (): void => void server.mcp.close().finally(() => process.exit(0));
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
