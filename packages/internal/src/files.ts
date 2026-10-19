/** Output paths and no-clobber atomic writes. */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { badInput } from "./errors";

export function resolvePath(input: string, root: string): string {
  const value = input.trim();
  if (!value) throw badInput("Path must not be empty.");
  if (value === "~") return os.homedir();
  const expanded = /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(root, expanded);
}

/** Short, filesystem-safe name derived from free text. */
export function slug(text: string, fallback: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return words.slice(0, 6).join("-").slice(0, 60) || fallback;
}

const STOP_WORDS = new Set("a an the of in on at with and or for to from by into over very".split(" "));

export interface OutputPlan {
  dir: string;
  base: string;
  /** Extension requested by the caller (from `output`), if any. */
  extension?: string;
}

/**
 * Interpret the caller's `output`: a directory (existing, or ending in `/`) or a file path.
 * Without `output`, files go to `root` and are named after `defaultName`.
 */
export async function planOutput(output: string | undefined, root: string, defaultName: string): Promise<OutputPlan> {
  if (!output?.trim()) return { dir: root, base: defaultName };
  const resolved = resolvePath(output, root);
  if (/[/\\]$/.test(output.trim()) || (await isDirectory(resolved))) return { dir: resolved, base: defaultName };
  const extension = path.extname(resolved);
  return {
    dir: path.dirname(resolved),
    base: path.basename(resolved, extension),
    ...(extension ? { extension: extension.toLowerCase() } : {}),
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}

/**
 * Write `data` as `<dir>/<base><ext>`, or as `<base>-<index><ext>` when `index` is set.
 * Without `overwrite`, an existing name is never replaced: the next free number is used
 * (`a.png` → `a-1.png`, `a-1.png` → `a-2.png`). Writes are atomic (temp file + link/rename).
 */
export async function writeOutput(
  plan: { dir: string; base: string },
  extension: string,
  data: string | Uint8Array,
  options: { overwrite?: boolean | undefined; index?: number | undefined } = {},
): Promise<string> {
  await fs.mkdir(plan.dir, { recursive: true });
  const temp = path.join(plan.dir, `.${plan.base}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(temp, data);
  try {
    for (let n = options.index ?? 0; n < (options.index ?? 0) + 10_000; n += 1) {
      const target = path.join(plan.dir, `${plan.base}${n > 0 ? `-${n}` : ""}${extension}`);
      if (options.overwrite) {
        await fs.rename(temp, target);
        return target;
      }
      try {
        await linkExclusive(temp, target);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw badInput(`No free file name for ${plan.base}${extension}.`, "Pass `overwrite: true` or another `output`.");
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Hard link fails with EEXIST instead of clobbering; filesystems without links fall back to an exclusive copy. */
async function linkExclusive(source: string, target: string): Promise<void> {
  try {
    await fs.link(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}
