/**
 * Runtime wiring for @dtst/txt. Configuration is resolved lazily so the
 * server can start without credentials and still answer `list_tools`.
 */

import { ArtifactStore, type ProviderConfig, type ToolContext, loadConfig } from "@dtst/internal";
import type { OperationContext } from "./operations";

export interface ToolRuntime {
  artifacts: ArtifactStore;
  config(): ProviderConfig;
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
