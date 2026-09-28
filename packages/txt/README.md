# @dtst/txt

MCP server **and** CLI for writing text, reasoning over workspace context, and
reading images — through any OpenAI-compatible API (OpenAI, OpenRouter, vLLM,
Ollama, LiteLLM). Multiple images per request, agent-chosen save paths, and
context pulled from files, globs, directories, URLs or earlier results.

```bash
npx @dtst/txt --help          # CLI
npx @dtst/txt                 # MCP stdio server (what MCP clients run)
```

## Quick start

```bash
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=openai/gpt-6-luna

npx @dtst/txt write "Summarise RELEASE.md in five bullets" --context RELEASE.md
npx @dtst/txt write "Describe the attached screenshots" -i shots/*.png --format markdown --out-dir out
npx @dtst/txt chat "Reply with exactly: PONG" --json
```

`.env` files are discovered from the working directory upwards, so MCP clients
that spawn the server without your shell environment still work.

## MCP client configuration

```json
{
  "mcpServers": {
    "txt": {
      "command": "npx",
      "args": ["-y", "@dtst/txt"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "openai/gpt-6-luna",
        "DTST_WORKSPACE": "/absolute/path/to/project"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `write_text` | One-shot generation: draft, summarise, rewrite, translate, extract. Takes `instructions`, optional `input`, `context` sources and `images`. |
| `chat` | Multi-turn conversation. Pass the full message history; images attach to the last user turn. |
| `read_context` | Read files, globs, directories, URLs, inline text or earlier artifacts and return them as fenced text plus image content blocks. |
| `list_models` | Model ids, context sizes and which models accept images. |

Plus a `write` MCP prompt that turns a rough task into a well-formed
`write_text` call, and MCP resources at `dtst://artifact/<id>` for everything
the server has written or read.

### Context sources

```jsonc
"context": {
  "files":     ["README.md", "docs/*.md", "dtst://artifact/1a2b3c"],
  "dirs":      ["src"],
  "urls":      ["https://example.com/spec.json"],
  "text":      ["inline snippet"],
  "artifacts": ["dtst://artifact/9f8e7d"]
}
```

Reads are budgeted (256 KiB per source, 1 MiB total, 64 files by default) and
every block is fenced with an explicit "untrusted reference data" warning so
file contents cannot smuggle instructions into the prompt. Anything skipped is
reported back instead of being silently dropped.

### Images

`images` accepts file paths, globs, `http(s)` URLs, `data:` URLs, raw base64 and
`dtst://artifact/<id>` URIs, up to 16 per call. Vision models receive them as
standard `image_url` parts; models without vision support will reject the
request with the provider's own error.

## Saving results

Text is returned inline. It is written to disk when you pass a destination:

```
output_path   exact file or directory (wins over output_dir)
output_dir    directory; the file name comes from the instructions
filename      preferred name; extension depends on `format` (.md/.json)
overwrite     false (default) appends -1, -2, … instead of clobbering
save          true/false to force or forbid writing
```

Relative paths resolve against `DTST_WORKSPACE`. Writes are atomic and
collision-safe; `DTST_ALLOWED_WRITE_ROOTS` can confine them.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_BASE_URL` | – (required) | API root; `/v1` added when missing. |
| `OPENAI_API_KEY` | – (required) | Bearer token. Optional for localhost endpoints unless `DTST_ALLOW_NO_API_KEY=0`. |
| `OPENAI_MODEL` | – | Default text model. |
| `DTST_TXT_API` | `chat` | `chat` (`/chat/completions`) or `responses` (`/responses`). Falls back to `chat` when unsupported. |
| `DTST_WORKSPACE` | cwd | Root for relative paths. |
| `DTST_OUTPUT_DIR` | workspace | Default output directory. |
| `DTST_ALLOWED_WRITE_ROOTS` | – | Colon-separated allow-list for writes. |
| `DTST_MAX_IMAGE_BYTES` / `DTST_MAX_IMAGES` | 26214400 / 16 | Image input limits. |
| `DTST_TIMEOUT_MS` / `DTST_MAX_RETRIES` | 600000 / 2 | Request timeout and retry policy (`Retry-After` aware). |
| `DTST_EXTRA_HEADERS` / `DTST_EXTRA_BODY` | – | JSON merged into every request. |
| `DTST_LOG_LEVEL` | `warn` | stderr only — stdout is the MCP JSON-RPC channel. |
| `DEBUG` | – | `true` is shorthand for `DTST_LOG_LEVEL=debug`. |
| `DTST_ENV_FILE` | – | Explicit `.env` path. |

## CLI

```bash
txt write "Draft a changelog entry for this diff" --context git-diff.txt --format markdown
txt write "Extract the invoice totals" -i invoices/*.png --format json --out invoices.json
txt chat "Explain this stack trace" -i screenshot.png --stream
txt read docs/*.md src/index.ts --json
txt models --query luna
txt config                        # effective configuration, secrets redacted
txt serve                         # run the MCP server explicitly
```

Exit codes: `0` success, `1` runtime/provider error, `2` usage error.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `CONFIG_MISSING: OPENAI_BASE_URL is not set` | Export it, or add a `.env` next to the project — MCP clients do not inherit your shell. |
| Empty response from a reasoning model | Raise `max_tokens`; reasoning tokens count toward the budget. |
| `400 invalid_request_error: response_format` | Your endpoint lacks JSON mode; ask for JSON in `instructions` instead. |
| Images ignored | The model must accept image input (`list_models` shows `vision`). |
| `DTST_TXT_API=responses` fails | Set it back to `chat` (the default) — the server also downgrades automatically on the first rejection. |

## Development

Part of the [`arthuqa/dtst`](https://github.com/arthuqa/dtst) monorepo:

```bash
npm install
npm run typecheck && npm test && npm run build
node scripts/integration-test.mjs txt   # real provider calls, spends credit
```

MIT licensed.
