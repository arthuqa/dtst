# @dtst/txt

MCP server that hands writing, summarising, extraction and vision tasks to a second model through any OpenAI-compatible API. Answers can be grounded in workspace files, folders, URLs and images.

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

**Tools:** `generate_text` (a prompt or multi-turn messages, plus files, JSON mode and saving to a file) · `read_files` · `list_text_models`

For all options and client setup, see the [project README](https://github.com/arthuqa/dtst#readme). `npx @dtst/txt --help` lists the environment variables. MIT licensed.
