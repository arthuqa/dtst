/**
 * MCP server assembly for @dtst/img.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ArtifactStore,
  type Logger,
  type ProviderConfig,
  createLogger,
  packageName,
  packageVersion,
  registerArtifactResources,
  serveStdio,
  type ServerLike,
  type StdioServerHandle,
} from "@dtst/internal";
import { createToolRuntime } from "./runtime";
import { registerGenerateImageTool } from "./tools/generate";
import { registerEditImageTool } from "./tools/edit";
import { registerListImageModelsTool } from "./tools/models";

export const SERVER_INSTRUCTIONS = [
  "Image generation and editing for the local workspace.",
  "",
  "Configuration (environment or .env): OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_IMAGE_MODEL (default model).",
  "Optional: DTST_IMG_BACKEND=auto|images|openrouter|chat forces a wire protocol; DTST_WORKSPACE sets the path root;",
  "DTST_ALLOWED_WRITE_ROOTS confines writes; DTST_OUTPUT_DIR redirects default output.",
  "",
  "Workflow:",
  "1. Optionally call list_image_models to confirm the model id and the backend in use.",
  "2. Call generate_image with a descriptive prompt. Pass n>1 for variants.",
  "3. Call edit_image with `images` pointing at file paths or at the artifact URIs returned by generate_image.",
  "4. Files are written to disk; the absolute path, a dtst://artifact/<id> URI and a file:// resource link are returned.",
  "5. Pass output_path/output_dir/filename whenever the user named a destination.",
].join("\n");

export interface CreateImgServerOptions {
  config?: ProviderConfig;
  artifacts?: ArtifactStore;
  log?: Logger;
}

export interface ImgServerBundle {
  server: McpServer;
  artifacts: ArtifactStore;
  log: Logger;
}

export function createImgServer(options: CreateImgServerOptions = {}): ImgServerBundle {
  const log = options.log ?? createLogger("img");
  const artifacts = options.artifacts ?? new ArtifactStore();
  const runtime = createToolRuntime({
    ...(options.config === undefined ? {} : { config: options.config }),
    artifacts,
  });

  const server = new McpServer(
    { name: packageName(), version: packageVersion() },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  registerGenerateImageTool(server as unknown as ServerLike, runtime);
  registerEditImageTool(server as unknown as ServerLike, runtime);
  registerListImageModelsTool(server as unknown as ServerLike, runtime);

  registerArtifactResources(
    server as unknown as Parameters<typeof registerArtifactResources>[0],
    artifacts,
    ResourceTemplate as unknown as Parameters<typeof registerArtifactResources>[2],
  );

  return { server, artifacts, log };
}

export async function runImgServer(options: CreateImgServerOptions = {}): Promise<void> {
  const log = options.log ?? createLogger("img");
  await serveStdio(
    async (): Promise<StdioServerHandle> => {
      const { server } = createImgServer({ ...options, log });
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
