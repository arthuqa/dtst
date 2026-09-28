/**
 * @dtst/txt — MCP server and library for text generation, context reading and
 * vision over any OpenAI-compatible API.
 */

export {
  createTxtServer,
  runTxtServer,
  SERVER_INSTRUCTIONS,
  type CreateTxtServerOptions,
  type TxtServerBundle,
} from "./server";
export {
  runChat,
  runWriteText,
  completionClientFor,
  textOutcomeSummary,
  type ChatInput,
  type OperationContext,
  type SaveOptions,
  type SamplingOptions,
  type TextOutcome,
  type WriteTextInput,
} from "./operations";
export { createToolRuntime, type ToolRuntime } from "./runtime";
export {
  ChatCompletionsClient,
  ResponsesClient,
  createCompletionClient,
  mapUsage,
  toChatMessages,
  type ChatMessage,
  type CompletionClient,
  type CompletionRequest,
  type CompletionResult,
  type Usage,
} from "./api/completions";
export { BASE_SYSTEM_PROMPT, buildSystemPrompt, buildUserPrompt, extensionForFormat, slugify } from "./prompt";
