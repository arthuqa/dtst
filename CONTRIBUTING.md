# Contributing

Repository layout, checks and the release process for the `@dtst` MCP servers.
User-facing setup lives in [README.md](README.md).

## Layout

```
packages/
  internal/   private shared runtime (config, paths, images, MCP helpers)
              bundled into each published package; never published itself
  img/        @dtst/img  — OpenAI images, OpenRouter images, chat modalities
  txt/        @dtst/txt  — chat completions + responses, context, vision
scripts/
  integration-test.mjs   drives the built servers over MCP stdio (real calls)
  verify-packages.mjs    metadata + tarball + `npx <tarball> <bin>` checks
  release.mjs            version bump, commit, tag, optional push
  check-bundle.mjs       fails a build if the private workspace leaks
```

## Setup and checks

```bash
npm install
npm run typecheck        # tsc --noEmit across workspaces
npm test                 # vitest, no network
npm run build            # tsup bundles: dist/index.js + dist/cli.js
npm run verify:packages  # metadata, tarball contents, `npx <bin> --version`
npm run check            # all of the above
```

Live tests spend real provider credit (a few cents per run):

```bash
npm run test:integration              # both servers
node scripts/integration-test.mjs img
node scripts/integration-test.mjs txt
```

They read `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` from the
environment or `.env`. Both servers take the same variables, so the harness
points the `img` server at an image model with `DTST_TEST_IMAGE_MODEL`
(falling back to `OPENAI_IMAGE_MODEL`, then `OPENAI_MODEL`) — test scaffolding
only; the servers themselves never read those.

## CI

`ci.yml` runs typecheck, unit tests, build and package verification on Node
22.14 and 24, with no secrets required. The live integration job runs on `main`
and manual dispatch when these repository secrets exist (otherwise it skips):

| Secret | Purpose |
| --- | --- |
| `OPENAI_BASE_URL` | API root for the integration run |
| `OPENAI_API_KEY` | Key used for the real calls |
| `OPENAI_MODEL` | Text model for the `txt` checks and default for `img` |
| `DTST_TEST_IMAGE_MODEL` | Optional image model for the `img` checks |

## Releasing

1. **Own the npm scope.** The first publish of `@dtst/img` / `@dtst/txt` must
   come from an account with rights to the `@dtst` scope.
2. **Configure authentication** — the workflow supports either:
   - *Trusted publishing (recommended, no secrets):* on npmjs.com open each
     package → Settings → Trusted Publisher → GitHub Actions and enter
     `arthuqa` / `dtst` / `publish.yml`, allowed action `npm publish`.
   - *Token fallback:* add an `NPM_TOKEN` repository secret (granular token
     with read+write on the scope).
3. **Publish:**

   ```bash
   npm run release -- img patch --push    # tags img-v0.1.1 and publishes
   npm run release -- txt minor --push
   npm run release -- both 1.0.0 --push
   ```

   Or run the **Publish** workflow manually — it defaults to a dry run, which
   builds and validates both tarballs without touching the registry.

The publish job fails fast when a tag disagrees with `package.json`, when
checks fail, or when a tarball is missing files. Publishes are provenance
signed when the token path is used.

## Design notes

- **stdout is sacred.** MCP stdio owns it for JSON-RPC; every diagnostic goes
  to stderr through a redacting logger (`DTST_LOG_LEVEL`, or `DEBUG=true`).
- **Errors are deliverables.** Tool failures return `isError` with a stable
  code, the provider's message and an actionable hint.
- **Writes are atomic and non-destructive** (temp file + fsync + rename, `-1`
  suffixes instead of clobbering) and can be confined with
  `DTST_ALLOWED_WRITE_ROOTS`.
- **Three variables.** `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL`
  configure both servers; anything else is optional and `DTST_*`-namespaced.
- **One implementation per capability.** The CLI and the MCP tools call the
  same operations layer, so behaviour cannot drift.
