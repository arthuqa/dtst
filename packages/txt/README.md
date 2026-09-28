# @dtst/txt

MCP server and CLI for writing text through any OpenAI-compatible API. It can
pull in files, globs, directories, URLs or earlier results as context, and can
look at one or many images.

```bash
npx -y @dtst/txt    # MCP stdio server
```

Tools: `write_text`, `chat`, `read_context`, `list_models`.

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # any OpenAI-compatible root
OPENAI_API_KEY=sk-...
OPENAI_MODEL=openai/gpt-6-luna                 # a TEXT model
```

Optional: `DEBUG=true` for verbose stderr logs, `DTST_WORKSPACE=/path` to
resolve relative paths, `DTST_OUTPUT_DIR=out` for a default destination. A
`.env` file next to your project is picked up automatically.

## Add to your client

This entry works as-is in Claude Desktop, Cursor, Windsurf, Cline and Roo
Code:

```json
{
  "mcpServers": {
    "txt": {
      "command": "npx",
      "args": ["-y", "@dtst/txt"],
      "env": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "openai/gpt-6-luna"
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

Use a text model: `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`,
`qwen/qwen3.8-max`. `txt models --vision` lists models that accept images.

### opencode

`opencode.json` — `command` is an array and env vars use `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "txt": {
      "type": "local",
      "command": ["npx", "-y", "@dtst/txt"],
      "environment": {
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "openai/gpt-6-luna"
      },
      "enabled": true
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.txt]
command = "npx"
args = ["-y", "@dtst/txt"]

[mcp_servers.txt.env]
OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
OPENAI_API_KEY = "sk-..."
OPENAI_MODEL = "openai/gpt-6-luna"
```

### Command-line clients

```bash
claude mcp add --transport stdio txt \
  --env OPENAI_API_KEY=sk-... --env OPENAI_MODEL=openai/gpt-6-luna \
  -- npx -y @dtst/txt

codex mcp add txt --env OPENAI_MODEL=openai/gpt-6-luna -- npx -y @dtst/txt

gemini mcp add -e OPENAI_MODEL=openai/gpt-6-luna txt npx -y @dtst/txt
```

## CLI

```bash
txt write "Summarise RELEASE.md in five bullets" --context RELEASE.md
txt write "Describe these screenshots" -i "shots/*.png" --format markdown
txt chat "Explain this stack trace" -i screenshot.png
txt read src/*.ts --json
txt --help
```

`write_text` takes context from files, globs, directories, URLs, inline text or
`dtst://artifact/<id>` references from earlier calls; reads are budgeted and
marked as untrusted data. Results are returned inline — pass `output_path` /
`output_dir` / `filename` to also save them (never overwriting unless you ask).

MIT licensed.
