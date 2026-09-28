#!/usr/bin/env node
/**
 * Pre-publish verification for the @dtst packages.
 *
 *   node scripts/verify-packages.mjs [--package img|txt] [--no-install]
 *
 * Three layers, cheapest first:
 *   1. static metadata checks against `npm pack --dry-run --json`
 *   2. bundle checks (shebang, inlined private workspace, no stray chunks)
 *   3. a real `npm pack` + `npx --package <tarball> <bin> --version`, which is
 *      the closest local equivalent of `npx @dtst/img`.
 *
 * Exit code 0 only when every package passes every check.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--package");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
const skipInstall = args.includes("--no-install");

const PACKAGES = [
  { dir: "packages/img", name: "@dtst/img", bin: "img" },
  { dir: "packages/txt", name: "@dtst/txt", bin: "txt" },
].filter((entry) => !only || entry.bin === only || entry.name === only);

const failures = [];
const notes = [];

function fail(pkg, message) {
  failures.push(`${pkg}: ${message}`);
  console.error(`  ✗ ${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function packJson(dir) {
  const output = run("npm", ["pack", "--dry-run", "--json"], { cwd: dir });
  const parsed = JSON.parse(output);
  // npm returns an array (older versions) or an object keyed by package name.
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry) throw new Error("npm pack --json returned no package entry");
  return entry;
}

for (const pkg of PACKAGES) {
  const dir = path.join(ROOT, pkg.dir);
  console.log(`\n▶ ${pkg.name} (${pkg.dir})`);

  if (!existsSync(path.join(dir, "dist", "cli.js"))) {
    fail(pkg.name, "dist/cli.js is missing — run the build first");
    continue;
  }

  // ── 1. static metadata ────────────────────────────────────────────────
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (manifest.name !== pkg.name) fail(pkg.name, `package.json name is ${manifest.name}`);
  if (manifest.bin?.[pkg.bin] !== "dist/cli.js") {
    fail(pkg.name, `bin.${pkg.bin} must point at dist/cli.js (npx resolves the bin by the unscoped name)`);
  }
  if (manifest.publishConfig?.access !== "public") fail(pkg.name, "publishConfig.access must be public for a scoped package");
  if (!manifest.engines?.node) fail(pkg.name, "engines.node must be declared (>=22.14)");
  if (!manifest.repository?.url?.includes("github.com/")) fail(pkg.name, "repository.url is required for provenance");
  if (!manifest.files?.includes("dist")) fail(pkg.name, "files must include dist");
  if (manifest.dependencies?.["@dtst/internal"]) {
    fail(pkg.name, "@dtst/internal must not be a runtime dependency (it is inlined at build time)");
  }
  if (manifest.private === true) fail(pkg.name, "package is marked private");
  ok("metadata (bin, publishConfig, engines, repository, files)");

  // ── 2. bundle ─────────────────────────────────────────────────────────
  const bundle = readFileSync(path.join(dir, "dist", "cli.js"), "utf8");
  if (!bundle.startsWith("#!/usr/bin/env node")) fail(pkg.name, "dist/cli.js is missing its shebang");
  if (bundle.includes("@dtst/internal")) fail(pkg.name, "dist/cli.js still references the private workspace");
  if (/from\s+["']\.\/[^"']+["']/.test(bundle)) fail(pkg.name, "dist/cli.js imports relative chunks (splitting must stay off)");
  const bundleKb = statSync(path.join(dir, "dist", "cli.js")).size / 1024;
  ok(`bundle self-contained (${bundleKb.toFixed(1)} KiB)`);

  // ── 3. tarball contents ───────────────────────────────────────────────
  const packed = packJson(dir);
  const files = packed.files.map((file) => file.path);
  for (const required of ["package.json", "dist/cli.js", "dist/index.js", "README.md"]) {
    if (!files.includes(required)) fail(pkg.name, `tarball is missing ${required}`);
  }
  const leaked = files.filter((file) => /^(src|test)\//.test(file) || file.includes("node_modules") || file.endsWith(".test.ts"));
  if (leaked.length > 0) fail(pkg.name, `tarball leaks source/test files: ${leaked.slice(0, 5).join(", ")}`);
  if (packed.unpackedSize > 4 * 1024 * 1024) fail(pkg.name, `unpacked size ${packed.unpackedSize} bytes is unexpectedly large`);
  notes.push(`${pkg.name}: tarball ${files.length} files, ${(packed.size / 1024).toFixed(1)} KiB packed`);
  ok(`tarball contents (${files.length} files, ${(packed.size / 1024).toFixed(1)} KiB)`);

  // ── 4. npx smoke test on the real tarball ─────────────────────────────
  if (skipInstall) continue;
  const workdir = mkdtempSync(path.join(os.tmpdir(), `dtst-${pkg.bin}-`));
  try {
    const tarball = run("npm", ["pack", "--silent", "--pack-destination", workdir], { cwd: dir }).trim().split("\n").pop();
    const tarballPath = path.join(workdir, tarball);
    if (!existsSync(tarballPath)) {
      fail(pkg.name, `npm pack did not produce a tarball (got ${tarball})`);
      continue;
    }
    const version = run("npx", ["--yes", `--package=${tarballPath}`, pkg.bin, "--version"], { cwd: workdir });
    if (!version.includes(manifest.version)) fail(pkg.name, `npx ${pkg.bin} --version printed ${JSON.stringify(version.trim())}`);
    const help = run("npx", ["--yes", `--package=${tarballPath}`, pkg.bin, "--help"], { cwd: workdir });
    if (!help.includes("serve")) fail(pkg.name, "CLI --help does not mention the `serve` command");
    ok(`npx ${pkg.bin} runs from the packed tarball (v${manifest.version})`);
  } catch (error) {
    fail(pkg.name, `npx smoke test failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

console.log("");
for (const note of notes) console.log(`• ${note}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} verification failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nPackage verification passed.");
