#!/usr/bin/env node
import { VERSION, runStdio } from "@dtst/internal";
import { NAME, createServer } from "./server";

const HELP = `
${NAME} ${VERSION} — MCP server: text generation, file reading and vision via any OpenAI-compatible API.

Tools:  generate_text · read_files · list_text_models

Environment:
  OPENAI_BASE_URL   API root (default https://api.openai.com/v1)
  OPENAI_API_KEY    API key (optional for local endpoints)
  OPENAI_MODEL      default text model
  DTST_WORKSPACE    root for relative paths (default: client root, else cwd)
  DTST_TIMEOUT_MS   request timeout (default 300000)
  DEBUG=1           verbose logs on stderr

A .env file in the working directory is loaded too.
`;

await runStdio(createServer, { name: NAME, version: VERSION, help: HELP });
