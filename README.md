# dtst

Two `npx`-able MCP servers that give agents real file-producing capabilities on
top of any OpenAI-compatible API.

| Package | Command | What it does |
| --- | --- | --- |
| [`@dtst/img`](packages/img) | `npx @dtst/img` | Generates and edits images, saves them wherever the agent asks, returns them inline. |
| [`@dtst/txt`](packages/txt) | `npx @dtst/txt` | Writes text, reads workspace context, and reasons over one or many images. |

Both speak OpenAI's wire format (`OPENAI_BASE_URL`, `OPENAI_API_KEY`,
`OPENAI_MODEL`), work over MCP stdio, log only to
stderr, save atomically, redact secrets, and ship a CLI that mirrors the MCP
tools so everything can be scripted and tested.

```jsonc
// MCP client configuration
{
  "mcpServers": {
    "img": { "command": "npx", "args": ["-y", "@dtst/img"] },
    "txt": { "command": "npx", "args": ["-y", "@dtst/txt"] }
  }
}
```

## Repository layout

```
packages/
  internal/   private shared runtime (config, paths, images, MCP helpers)
              — never published, inlined into each bundle by tsup
  img/        @dtst/img  — backends: OpenAI images, OpenRouter images, chat modalities
  txt/        @dtst/txt  — chat completions + responses, context gathering, vision
scripts/
  integration-test.mjs   spawns the built servers over MCP stdio and makes real calls
  verify-packages.mjs    static + tarball + `npx --package <tgz>` verification
  release.mjs            version bump, commit, tag, optional push
.github/workflows/
  ci.yml       typecheck · unit tests · build · package verification (Node 22 + 24)
  publish.yml  tag-triggered publish to npm (Trusted Publishing or NPM_TOKEN)
```

## Working on it

```bash
npm install
npm run typecheck        # tsc --noEmit across workspaces
npm test                 # vitest, no network
npm run build            # tsup bundles: dist/index.js + dist/cli.js
npm run verify:packages  # metadata, tarball contents, `npx <bin> --version`
npm run check            # all of the above
```

Live tests (they spend real credit, a few cents):

```bash
npm run test:integration            # both servers, requires credentials
node scripts/integration-test.mjs img
node scripts/integration-test.mjs txt
```

## Releasing

1. **Create the npm scope/user** and make sure you can publish to it. Scoped
   packages need `publishConfig.access: public` (already set) and a first
   `npm publish` from an account that owns the scope.
2. **Configure npm authentication** — the workflow supports both:
   - *Trusted publishing (recommended, no secrets):* on npmjs.com open each
     package → Settings → Trusted Publisher → GitHub Actions and fill in
     `arthuqa` / `dtst` / `publish.yml` / allowed action `npm publish`.
   - *Token fallback:* add an `NPM_TOKEN` repository secret (granular token with
     read+write on the scope).
3. **Publish:**

   ```bash
   npm run release -- img patch --push     # tags img-v0.1.1, pushes, publishes
   npm run release -- txt minor --push
   npm run release -- both 1.0.0 --push
   ```

   Or run the **Publish** workflow manually — it defaults to a dry run, which
   builds and validates both tarballs without touching the registry.

The publish job fails fast when a tag and `package.json` version disagree, when
typechecks/unit tests fail, or when the packed tarball is missing files.

### CI secrets

`ci.yml` runs typecheck/unit/build/package verification on every push and PR
with no secrets. The live integration job runs on `main` (and manual dispatch)
only when these repository secrets exist:

| Secret | Purpose |
| --- | --- |
| `OPENAI_BASE_URL` | API root for the integration run. |
| `OPENAI_API_KEY` | Key used for the few real calls. |
| `OPENAI_MODEL` | Model for the `txt` checks and the default for `img`. |
| `DTST_IMAGE_MODEL` | Optional image-only model for the `img` checks. |

Without them the job skips with a notice instead of failing.

## Design notes

- **stdout is sacred.** MCP stdio owns it for JSON-RPC; every diagnostic goes to
  stderr through a redacting logger.
- **Errors are deliverables.** Tool failures return `isError` with a stable
  `code`, the provider's message and an actionable `hint`; secrets are scrubbed.
- **Writes are atomic and non-destructive** (temp file + `fsync` + rename,
  `-1`/`-2` suffixes instead of clobbering) and can be confined with
  `DTST_ALLOWED_WRITE_ROOTS`.
- **Protocol autodetection.** Image models live behind three different wire
  protocols; `@dtst/img` picks the right one per host/model and retries the
  other on "model cannot be used with this endpoint" responses.
- **One implementation per capability.** The CLI and the MCP tools call the same
  operations layer, so behaviour cannot drift between them.

MIT licensed.
