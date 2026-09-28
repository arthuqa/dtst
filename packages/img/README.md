# @dtst/img

MCP server and CLI for generating and editing images through any
OpenAI-compatible API (OpenAI, OpenRouter, LiteLLM, vLLM, …). Images are saved
wherever you ask and returned inline for vision-capable clients.

```bash
npx -y @dtst/img    # MCP stdio server
```

Tools: `generate_image`, `edit_image`, `list_image_models`.

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible root
OPENAI_API_KEY=sk-...
OPENAI_MODEL=meta/muse-image                   # an IMAGE model
```

Optional: `DEBUG=true` for verbose stderr logs, `DTST_WORKSPACE=/path` to
resolve relative output paths, `DTST_OUTPUT_DIR=out` for a default
destination. A `.env` file next to your project is picked up automatically.

## Add to your client

This entry works as-is in Claude Desktop, Cursor, Windsurf, Cline and Roo
Code:

```json
{
  "mcpServers": {
    "img": {
      "command": "npx",
      "args": ["-y", "@dtst/img"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "meta/muse-image"
      }
    }
  }
}
```

| Client | Where it goes | Key |
| --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `mcpServers` (add `"type": "stdio"`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Cline | `~/.cline/mcp.json` | `mcpServers` |
| Roo Code | `.roo/mcp.json` | `mcpServers` |
| VS Code (Copilot) | `.vscode/mcp.json` | `servers` + `"type": "stdio"` |
| Zed | Zed `settings.json` | `context_servers` |
| JetBrains | Settings → Tools → AI Assistant → MCP → Add → STDIO | paste the JSON above |

Use an image model: `meta/muse-image`, `google/gemini-3.1-flash-image`,
`openai/gpt-image-1`, `dall-e-3`. `img models` lists what your endpoint offers.

### opencode

`opencode.json` — `command` is an array and env vars use `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "img": {
      "type": "local",
      "command": ["npx", "-y", "@dtst/img"],
      "environment": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "meta/muse-image"
      },
      "enabled": true
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.img]
command = "npx"
args = ["-y", "@dtst/img"]

[mcp_servers.img.env]
OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_API_KEY = "sk-..."
OPENAI_MODEL = "meta/muse-image"
```

### Command-line clients

```bash
claude mcp add --transport stdio img \
  --env OPENAI_API_KEY=sk-... --env OPENAI_MODEL=meta/muse-image \
  -- npx -y @dtst/img

codex mcp add img --env OPENAI_MODEL=meta/muse-image -- npx -y @dtst/img

gemini mcp add -e OPENAI_MODEL=meta/muse-image img npx -y @dtst/img
```

## CLI

The same operations without an MCP client:

```bash
img generate "a red panda astronaut, studio lighting" --out-dir out
img edit "make it a watercolour" -i out/panda.png --out out/panda-water.png
img models
img --help
```

Generated files land in the working directory (`DTST_WORKSPACE`) unless the
call passes `output_path` / `output_dir` / `filename`; existing files are never
overwritten unless you ask.

MIT licensed.
