/**
 * Path resolution and durable writes.
 *
 * Agents choose where output lands (`output_path`, `output_dir`, `filename`).
 * Those values are untrusted input, so every path goes through this module,
 * which normalizes it, expands `~`, keeps relative paths inside the workspace
 * root, optionally confines writes to an allow-list, and writes atomically.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DtstError, badInput, outputError } from "./errors";
import { logger } from "./log";

export type CollisionPolicy = "suffix" | "overwrite" | "error";

export interface PathOptions {
  /** Root used to resolve relative paths. Defaults to `process.cwd()`. */
  root?: string;
  /** When set, writes outside these roots are rejected. */
  allowedWriteRoots?: readonly string[];
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function workspaceRoot(options: PathOptions = {}): string {
  const root = options.root?.trim();
  return path.resolve(root && root.length > 0 ? expandHome(root) : process.cwd());
}

/** Normalize a user-supplied path against the workspace root. */
export function resolveUserPath(input: string, options: PathOptions = {}): string {
  const raw = input.trim();
  if (!raw) throw badInput("Path must not be empty.");
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.normalize(path.join(workspaceRoot(options), expanded));
}

export function stripTrailingSeparators(input: string): string {
  if (input === path.parse(input).root) return input;
  return input.replace(/[/\\]+$/, "");
}

export function sanitizeFilename(input: string): string {
  const base = path.basename(input.trim());
  const cleaned = base
    // oxlint-disable-next-line no-control-regex -- deliberately stripping control characters from filenames
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw badInput(`Invalid filename: ${JSON.stringify(input)}`);
  return cleaned.slice(0, 180);
}

function withExtension(filename: string, extension: string | undefined): string {
  if (!extension) return filename;
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return path.extname(filename) ? filename : `${filename}${ext}`;
}

export interface OutputSpec {
  /** Full path (file or directory) explicitly requested by the caller. */
  outputPath?: string | undefined;
  /** Directory the file should be written to. */
  outputDir?: string | undefined;
  /** Preferred file name, without or with extension. */
  filename?: string | undefined;
  /** File name to use when the caller did not provide one. */
  defaultFilename: string;
  /** Extension appended when the chosen name has none. */
  extension?: string | undefined;
}

/**
 * Turn the caller's output fields into a concrete absolute file path.
 * `output_path` wins over `output_dir`; both may point at a directory.
 */
export async function resolveOutputFile(spec: OutputSpec, options: PathOptions = {}): Promise<string> {
  const root = workspaceRoot(options);
  const fallbackName = withExtension(sanitizeFilename(spec.defaultFilename), spec.extension);

  if (spec.outputPath && spec.outputPath.trim()) {
    const resolved = resolveUserPath(spec.outputPath, options);
    const looksLikeDirectory = /[/\\]$/.test(spec.outputPath.trim()) || (await isDirectory(resolved));
    if (looksLikeDirectory) {
      const name = spec.filename ? withExtension(sanitizeFilename(spec.filename), spec.extension) : fallbackName;
      return path.join(resolved, name);
    }
    return withExtension(resolved, path.extname(resolved) ? undefined : spec.extension);
  }

  const dir = spec.outputDir && spec.outputDir.trim() ? resolveUserPath(spec.outputDir, options) : root;
  const name = spec.filename ? withExtension(sanitizeFilename(spec.filename), spec.extension) : fallbackName;
  return path.join(dir, name);
}

export async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export function assertWritableTarget(file: string, options: PathOptions = {}): void {
  const roots = options.allowedWriteRoots?.filter((entry) => entry.trim().length > 0) ?? [];
  if (roots.length === 0) return;

  const resolved = path.resolve(file);
  const allowed = roots.some((root) => {
    const normalized = path.resolve(expandHome(root.trim()));
    return resolved === normalized || resolved.startsWith(`${normalized}${path.sep}`);
  });
  if (!allowed) {
    throw new DtstError("PERMISSION", `Refusing to write outside the allowed roots: ${resolved}`, {
      hint: `DTST_ALLOWED_WRITE_ROOTS=${roots.join(":")}. Choose a path inside one of those directories or unset the variable.`,
    });
  }
}

/** Serialize suffix selection + rename per directory to avoid in-process races. */
const directoryLocks = new Map<string, Promise<unknown>>();

async function withDirectoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = directoryLocks.get(dir) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  directoryLocks.set(
    dir,
    next.catch(() => undefined),
  );
  try {
    return await next;
  } finally {
    if (directoryLocks.get(dir) === next || directoryLocks.get(dir) === undefined) directoryLocks.delete(dir);
  }
}

/** `photo.png` -> `photo-1.png` -> `photo-2.png` ... */
export function suffixPath(file: string, index: number): string {
  if (index <= 0) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  return path.join(dir, `${base}-${index}${ext}`);
}

export async function uniqueFilePath(file: string, maxAttempts = 10_000): Promise<string> {
  for (let index = 0; index < maxAttempts; index += 1) {
    const candidate = suffixPath(file, index);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw outputError(`Could not find a free file name for ${file}.`, {
    hint: "Pass an explicit `filename` or `output_path` to overwrite an existing file.",
  });
}

export interface SaveResult {
  path: string;
  bytes: number;
  overwritten: boolean;
}

/**
 * Write bytes to `target` atomically (temp file + fsync + rename).
 * `suffix` never clobbers an existing file; `overwrite` replaces it.
 */
export async function saveFile(
  target: string,
  data: string | Uint8Array,
  options: { policy?: CollisionPolicy; options?: PathOptions } = {},
): Promise<SaveResult> {
  const policy = options.policy ?? "suffix";
  const pathOptions = options.options ?? {};

  return withDirectoryLock(path.dirname(path.resolve(target)), async () => {
    let finalPath = path.resolve(target);
    let overwritten = false;

    if (policy !== "overwrite") {
      const exists = await pathExists(finalPath);
      if (exists && policy === "error") {
        throw outputError(`File already exists: ${finalPath}`, {
          hint: "Pass `overwrite: true` to replace it, or a different `filename`.",
        });
      }
      if (exists) {
        finalPath = await uniqueFilePath(finalPath);
      }
    } else {
      overwritten = await pathExists(finalPath);
    }

    assertWritableTarget(finalPath, pathOptions);

    const directory = path.dirname(finalPath);
    await fs.mkdir(directory, { recursive: true });

    const temporary = path.join(directory, `.${path.basename(finalPath)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await fs.open(temporary, "w", 0o644);
      try {
        await handle.writeFile(data);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, finalPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS") {
        throw new DtstError("PERMISSION", `Cannot write ${finalPath}: ${err.message}`, {
          hint: "Choose a writable output directory (e.g. inside the workspace) or fix permissions.",
          cause: error,
        });
      }
      throw outputError(`Failed to write ${finalPath}: ${err.message}`, { cause: error });
    }

    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    logger.debug("wrote file", { path: finalPath, bytes, overwritten });
    return { path: finalPath, bytes, overwritten };
  });
}

export function fileUri(file: string): string {
  return pathToFileURL(path.resolve(file)).href;
}

export function pathFromFileUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return undefined;
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

export function relativeForDisplay(file: string, options: PathOptions = {}): string {
  const root = workspaceRoot(options);
  const relative = path.relative(root, path.resolve(file));
  return relative && !relative.startsWith("..") ? relative : file;
}

export async function readTextFile(
  file: string,
  options: { maxBytes?: number } = {},
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const resolved = path.resolve(file);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new DtstError("NOT_FOUND", `File not found: ${resolved}`);
    if (err.code === "EISDIR") throw badInput(`${resolved} is a directory, expected a file.`);
    throw new DtstError("PERMISSION", `Cannot read ${resolved}: ${err.message}`, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw badInput(`${resolved} is a directory, expected a file.`);
    const limit = Math.max(0, Math.min(maxBytes, stat.size));
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    const truncated = stat.size > bytesRead;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead, truncated };
  } finally {
    await handle.close();
  }
}
