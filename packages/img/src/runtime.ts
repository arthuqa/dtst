/**
 * Runtime wiring: configuration is resolved lazily so the server can start
 * (and answer `list_tools`) even when credentials are missing — the error then
 * arrives as an actionable tool response instead of a crash at startup.
 */

import { ArtifactStore, type ProviderConfig, type ToolContext, loadConfig } from "@dtst/internal";
import type { OperationContext } from "./operations";

export interface ToolRuntime {
  artifacts: ArtifactStore;
  /** Resolve the effective config, throwing a hinted error when incomplete. */
  config(): ProviderConfig;
  /** Build the operations-layer context from an MCP tool context. */
  operationContext(tool: ToolContext): OperationContext;
}

export function createToolRuntime(options: { config?: ProviderConfig; artifacts?: ArtifactStore } = {}): ToolRuntime {
  const artifacts = options.artifacts ?? new ArtifactStore();
  return {
    artifacts,
    config: () => options.config ?? loadConfig(),
    operationContext: (tool) => ({
      config: options.config ?? loadConfig(),
      log: tool.log,
      progress: tool.progress,
      signal: tool.signal,
      artifacts,
    }),
  };
}
