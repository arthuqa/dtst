#!/usr/bin/env node
/**
 * Post-build verification for a publishable bundle.
 *
 * Catches the failure modes that only show up after `npm publish`:
 *   - the private @dtst/internal workspace leaking into the bundle
 *   - a missing shebang (breaks the `bin` entry)
 *   - relative chunk imports that would not survive `files: ["dist"]`
 *
 * Usage: node scripts/check-bundle.mjs packages/img/dist/cli.js
 */

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: check-bundle.mjs <path/to/dist/cli.js>");
  process.exit(2);
}

const file = path.resolve(target);
const failures = [];
const notes = [];

if (!existsSync(file)) {
  failures.push(`bundle is missing: ${file}`);
} else {
  const source = readFileSync(file, "utf8");
  const size = statSync(file).size;

  if (!source.startsWith("#!/usr/bin/env node\n")) {
    failures.push("bundle does not start with `#!/usr/bin/env node` (the bin entry would not run)");
  }

  if (/@dtst\/internal/.test(source)) {
    failures.push("bundle still references @dtst/internal (the private workspace must be inlined)");
  }

  const relativeImports = [...source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map((match) => match[1]);
  if (relativeImports.length > 0) {
    failures.push(`bundle imports relative chunks (${relativeImports.join(", ")}); set splitting: false`);
  }

  if (/\bprocess\.stdout\.write\(/.test(source) === false) {
    notes.push("no process.stdout.write found; CLI output may be missing");
  }

  chmodSync(file, 0o755);
  notes.push(`bundle ok: ${path.relative(process.cwd(), file)} (${(size / 1024).toFixed(1)} KiB)`);
}

for (const note of notes) console.error(`[check-bundle] ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-bundle] FAIL ${failure}`);
  process.exit(1);
}
