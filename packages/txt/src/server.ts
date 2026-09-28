/**
 * MCP server assembly for @dtst/txt.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ArtifactStore,
  type Logger,
  type ProviderConfig,
  type ServerLike,
  type StdioServerHandle,
  createLogger,
  packageName,
  packageVersion,
  registerArtifactResources,
  serveStdio,
} from "@dtst/internal";
import { createToolRuntime } from "./runtime";
import { registerWriteTextTool } from "./tools/write";
import { registerChatTool } from "./tools/chat";
import { registerReadContextTool } from "./tools/read-context";
import { registerListModelsTool } from "./tools/models";

export const SERVER_INSTRUCTIONS = [
  "Text generation, reasoning over workspace context, and vision for the local workspace.",
  "",
  "Configuration (environment or .env): OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL (default model).",
  "Optional: DTST_TXT_API=chat|responses selects the API surface; DTST_WORKSPACE sets the path root;",
  "DTST_ALLOWED_WRITE_ROOTS confines writes; DTST_OUTPUT_DIR redirects default output.",
  "",
  "Workflow:",
  "1. read_context to pull files/globs/directories/URLs/images into the conversation, or pass `context` to write_text.",
  "2. write_text for one-shot tasks (draft/summarise/rewrite/extract); chat for multi-turn conversations.",
  "3. Attach images with the `images` field for vision models; multiple images per call are supported.",
  "4. Results are returned inline. Pass output_path/output_dir/filename to have the result written to disk.",
  "5. list_models shows model ids, context sizes and which models accept images.",
].join("\n");

export interface CreateTxtServerOptions {
  config?: ProviderConfig;
  artifacts?: ArtifactStore;
  log?: Logger;
}

export interface TxtServerBundle {
  server: McpServer;
  artifacts: ArtifactStore;
  log: Logger;
}

export function createTxtServer(options: CreateTxtServerOptions = {}): TxtServerBundle {
  const log = options.log ?? createLogger("txt");
  const artifacts = options.artifacts ?? new ArtifactStore();
  const runtime = createToolRuntime({
    ...(options.config === undefined ? {} : { config: options.config }),
    artifacts,
  });

  const server = new McpServer(
    { name: packageName(), version: packageVersion() },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  registerWriteTextTool(server as unknown as ServerLike, runtime);
  registerChatTool(server as unknown as ServerLike, runtime);
  registerReadContextTool(server as unknown as ServerLike, runtime);
  registerListModelsTool(server as unknown as ServerLike, runtime);

  registerArtifactResources(
    server as unknown as Parameters<typeof registerArtifactResources>[0],
    artifacts,
    ResourceTemplate as unknown as Parameters<typeof registerArtifactResources>[2],
  );

  server.registerPrompt(
    "write",
    {
      title: "Writing brief",
      description: "Turn a rough task into a well-formed write_text call with audience, tone and length.",
      argsSchema: {
        task: z.string().describe("What needs to be written."),
        audience: z.string().optional().describe("Who will read it."),
        tone: z.string().optional().describe("e.g. formal, friendly, terse."),
        length: z.string().optional().describe("e.g. one paragraph, 5 bullets, 800 words."),
      },
    },
    ({ task, audience, tone, length }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Call the write_text tool with these parameters:",
              `instructions: ${JSON.stringify(task)}`,
              audience ? `system: Write for ${audience}.` : undefined,
              tone ? `system: Tone: ${tone}.` : undefined,
              length ? `system: Length: ${length}.` : undefined,
              "Add `context` files if the task refers to workspace material, and `output_path` if a file was requested.",
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
          },
        },
      ],
    }),
  );

  return { server, artifacts, log };
}

export async function runTxtServer(options: CreateTxtServerOptions = {}): Promise<void> {
  const log = options.log ?? createLogger("txt");
  await serveStdio(
    async (): Promise<StdioServerHandle> => {
      const { server } = createTxtServer({ ...options, log });
      const transport = new StdioServerTransport();
      await server.connect(transport);
      return {
        close: async () => {
          await server.close();
        },
      };
    },
    { name: packageName(), version: packageVersion() },
    log,
  );
}
