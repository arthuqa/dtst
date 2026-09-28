# dtst

Two MCP servers, on any OpenAI-compatible API:

| Package | Run it | What it gives the model |
| --- | --- | --- |
| **`@dtst/img`** | `npx -y @dtst/img` | Generate and edit images, written wherever you ask. |
| **`@dtst/txt`** | `npx -y @dtst/txt` | Write text, read files/URLs as context, look at images. |

## Configuration

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1   # or https://api.openai.com/v1, a gateway, ...
OPENAI_API_KEY=sk-...
OPENAI_MODEL=meta/muse-image                   # the model THIS server uses
```

Each server has its own `env` block, so `img` can use an image model while
`txt` uses a text model. Optional: `DEBUG=true` for verbose logs on stderr.

## Add to your client

Use `@dtst/img` for images, `@dtst/txt` for text. This entry works as-is in
Claude Desktop, Cursor, Windsurf, Cline and Roo Code:

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

Any other MCP client works the same way: run `npx -y @dtst/img`, pass the three
variables through its env mechanism, and leave stdout alone (both servers log
to stderr only).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
