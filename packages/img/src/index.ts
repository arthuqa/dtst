/**
 * @dtst/img — MCP server and library for image generation and editing over any
 * OpenAI-compatible API.
 */

export {
  createImgServer,
  runImgServer,
  SERVER_INSTRUCTIONS,
  type CreateImgServerOptions,
  type ImgServerBundle,
} from "./server";
export {
  runGenerate,
  runEdit,
  type EditOperationInput,
  type GenerateOperationInput,
  type OperationContext,
  type OperationOutcome,
  type OutputOptions,
  type SavedImage,
} from "./operations";
export { createToolRuntime, type ToolRuntime } from "./runtime";
export {
  resolveBackend,
  listImageModels,
  isOpenRouter,
  describeSelection,
  type BackendSelection,
} from "./backends/select";
export type {
  BackendCapabilities,
  BackendContext,
  BackendKind,
  EditRequest,
  GenerateRequest,
  ImageBackend,
  ImageModelInfo,
  ImageResult,
  RenderedImage,
  Usage,
} from "./backends/types";
export { ChatModalitiesBackend } from "./backends/chat-modalities";
export { OpenAIImagesBackend } from "./backends/openai-images";
export { OpenRouterImagesBackend } from "./backends/openrouter-images";
export { buildPrompt, filenameFromPrompt, normalizePrompt } from "./prompt";
export { imgErrors, ERROR_UNSUPPORTED } from "./errors";
