#!/usr/bin/env node
/**
 * Release helper for the @dtst packages.
 *
 *   node scripts/release.mjs img patch            # 0.1.0 -> 0.1.1 (commit + tag, no push)
 *   node scripts/release.mjs txt 1.0.0 --push     # explicit version, then push
 *   node scripts/release.mjs both minor --push --skip-checks
 *
 * One commit per run and one tag per package (`img-v0.1.1`, `txt-v1.0.0`).
 * Tag pushes trigger .github/workflows/publish.yml.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PACKAGES = { img: "packages/img", txt: "packages/txt" };

const args = process.argv.slice(2);
const positional = args.filter((entry) => !entry.startsWith("--"));
const flags = new Set(args.filter((entry) => entry.startsWith("--")));
const [target, bump] = positional;

if (!target || !bump || !(target in PACKAGES || target === "both")) {
  console.error("usage: node scripts/release.mjs <img|txt|both> <patch|minor|major|x.y.z> [--push] [--skip-checks] [--yes]");
  process.exit(2);
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: ROOT, encoding: "utf8", stdio: "inherit", ...options });
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+/.test(kind)) return kind;
  const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump: ${kind}`);
}

async function confirm(question) {
  if (flags.has("--yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

const status = git("status", "--porcelain");
if (status && !flags.has("--allow-dirty")) {
  console.error("Working tree is not clean. Commit or stash first (or pass --allow-dirty).");
  console.error(status);
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main" && !flags.has("--allow-branch")) {
  console.error(`Refusing to release from branch "${branch}" (pass --allow-branch to override).`);
  process.exit(1);
}

const targets = target === "both" ? Object.keys(PACKAGES) : [target];
const planned = [];

for (const name of targets) {
  const manifestPath = path.join(ROOT, PACKAGES[name], "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = nextVersion(manifest.version, bump);
  planned.push({ name, manifestPath, manifest, version });
}

console.log("Planned release:");
for (const entry of planned) console.log(`  ${entry.name}: ${entry.manifest.version} -> ${entry.version}`);

if (!(await confirm("Proceed?"))) process.exit(0);

if (!flags.has("--skip-checks")) {
  console.log("\nRunning checks (typecheck, unit tests, build)…");
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  run("node", ["scripts/verify-packages.mjs", "--no-install"]);
}

for (const entry of planned) {
  entry.manifest.version = entry.version;
  writeFileSync(entry.manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`);
}

console.log("\nSyncing package-lock.json…");
run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);

const message = `release(${targets.join(",")}): ${planned.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`;
git("add", ...planned.map((entry) => path.relative(ROOT, entry.manifestPath)), "package-lock.json");
execFileSync("git", ["commit", "-m", message], { cwd: ROOT, stdio: "inherit" });

for (const entry of planned) {
  const tag = `${entry.name}-v${entry.version}`;
  execFileSync("git", ["tag", "-a", tag, "-m", tag], { cwd: ROOT, stdio: "inherit" });
  console.log(`tagged ${tag}`);
}

if (flags.has("--push")) {
  console.log("\nPushing…");
  execFileSync("git", ["push", "origin", branch, "--follow-tags"], { cwd: ROOT, stdio: "inherit" });
  console.log("Pushed. The publish workflow will build and publish to npm.");
} else {
  console.log("\nCommitted and tagged locally. Push with:");
  console.log(`  git push origin ${branch} --follow-tags`);
}
