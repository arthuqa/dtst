import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWritableTarget,
  resolveOutputFile,
  resolveUserPath,
  readTextFile,
  sanitizeFilename,
  saveFile,
  suffixPath,
  uniqueFilePath,
} from "@dtst/internal";
import { catchDtstError, cleanupDir, makeTempDir } from "./helpers";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir("dtst-paths-");
});

afterEach(async () => {
  await cleanupDir(dir);
});

describe("resolveUserPath", () => {
  it("resolves relative paths under the root", () => {
    expect(resolveUserPath("rel/x.txt", { root: dir })).toBe(path.join(dir, "rel", "x.txt"));
  });

  it("keeps absolute paths", () => {
    const absolute = path.join(dir, "abs.txt");
    expect(resolveUserPath(absolute, { root: "/somewhere/else" })).toBe(path.normalize(absolute));
  });

  it("expands ~ to the home directory", () => {
    expect(resolveUserPath("~/x.txt", { root: dir })).toBe(path.join(os.homedir(), "x.txt"));
    expect(resolveUserPath("~", { root: dir })).toBe(os.homedir());
  });

  it("rejects an empty path with BAD_INPUT", () => {
    const error = catchDtstError(() => resolveUserPath("   ", { root: dir }));
    expect(error.code).toBe("BAD_INPUT");
  });
});

describe("sanitizeFilename", () => {
  it("keeps the basename and removes path/OS-special characters", () => {
    expect(sanitizeFilename("a/b/../../c.txt")).toBe("c.txt");
    expect(sanitizeFilename("name?.png")).toBe("name-.png");
    expect(sanitizeFilename("  spaced name.png  ")).toBe("spaced-name.png");
  });

  it("collapses runs of separators and leading dots", () => {
    expect(sanitizeFilename("..a---b.txt")).toBe("a-b.txt");
  });

  it("throws BAD_INPUT when nothing usable remains", () => {
    expect(catchDtstError(() => sanitizeFilename("...")).code).toBe("BAD_INPUT");
  });
});

describe("resolveOutputFile", () => {
  it("uses output_path when it has an extension", async () => {
    const target = path.join(dir, "a.png");
    const resolved = await resolveOutputFile({ outputPath: target, defaultFilename: "ignored" }, { root: dir });
    expect(resolved).toBe(target);
  });

  it("joins an existing directory output_path with the filename", async () => {
    const resolved = await resolveOutputFile(
      { outputPath: dir, filename: "b.png", defaultFilename: "ignored" },
      { root: dir },
    );
    expect(resolved).toBe(path.join(dir, "b.png"));
  });

  it("uses output_dir + filename", async () => {
    const sub = path.join(dir, "sub");
    await mkdir(sub, { recursive: true });
    const resolved = await resolveOutputFile(
      { outputDir: sub, filename: "c", extension: ".png", defaultFilename: "ignored" },
      { root: dir },
    );
    expect(resolved).toBe(path.join(sub, "c.png"));
  });

  it("appends the extension when the requested name has none", async () => {
    const resolved = await resolveOutputFile(
      { outputPath: path.join(dir, "noext"), extension: ".png", defaultFilename: "ignored" },
      { root: dir },
    );
    expect(resolved).toBe(path.join(dir, "noext.png"));
  });

  it("falls back to the default filename", async () => {
    const resolved = await resolveOutputFile({ defaultFilename: "fallback", extension: "png" }, { root: dir });
    expect(resolved).toBe(path.join(dir, "fallback.png"));
  });
});

describe("suffixPath / uniqueFilePath", () => {
  it("suffixes before the extension", () => {
    expect(suffixPath("/a/b.png", 0)).toBe("/a/b.png");
    expect(suffixPath("/a/b.png", 2)).toBe("/a/b-2.png");
  });

  it("finds the first free name", async () => {
    const target = path.join(dir, "b.png");
    await writeFile(target, "x");
    expect(await uniqueFilePath(target)).toBe(path.join(dir, "b-1.png"));
  });
});

describe("saveFile", () => {
  it("never clobbers with the suffix policy and leaves no temp files", async () => {
    const target = path.join(dir, "name.png");
    const first = await saveFile(target, Buffer.from("one"));
    const second = await saveFile(target, Buffer.from("two"));

    expect(first.path).toBe(target);
    expect(first.overwritten).toBe(false);
    expect(path.basename(second.path)).toBe("name-1.png");

    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["name-1.png", "name.png"]);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect(await readFile(first.path, "utf8")).toBe("one");
  });

  it("replaces the file with the overwrite policy", async () => {
    const target = path.join(dir, "name.txt");
    await saveFile(target, "first", { policy: "overwrite" });
    const second = await saveFile(target, "second", { policy: "overwrite" });
    expect(second.path).toBe(target);
    expect(second.overwritten).toBe(true);
    expect(await readFile(target, "utf8")).toBe("second");
  });

  it("throws OUTPUT_WRITE with the error policy", async () => {
    const target = path.join(dir, "name.txt");
    await saveFile(target, "first");
    const error = await saveFile(target, "second", { policy: "error" }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: "OUTPUT_WRITE" });
  });

  it("creates parent directories", async () => {
    const target = path.join(dir, "deep", "nested", "name.txt");
    const result = await saveFile(target, "hello");
    expect(result.path).toBe(target);
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("refuses writes outside allowedWriteRoots with PERMISSION", async () => {
    const other = path.join(os.tmpdir(), `dtst-other-${Date.now()}`);
    const error = await saveFile(path.join(other, "x.txt"), "x", {
      options: { allowedWriteRoots: [dir] },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: "PERMISSION" });
  });

  it("allows writes inside allowedWriteRoots", async () => {
    const target = path.join(dir, "inside.txt");
    const result = await saveFile(target, "ok", { options: { allowedWriteRoots: [dir] } });
    expect(result.path).toBe(target);
  });
});

describe("assertWritableTarget", () => {
  it("is a no-op without roots and throws for a sibling prefix", () => {
    expect(() => assertWritableTarget(path.join(dir, "x.txt"))).not.toThrow();
    expect(() => assertWritableTarget(`${dir}-sibling/x.txt`, { allowedWriteRoots: [dir] })).toThrowError();
    expect(() => assertWritableTarget(path.join(dir, "x.txt"), { allowedWriteRoots: [dir] })).not.toThrow();
  });
});

describe("readTextFile", () => {
  it("truncates at maxBytes and reports it", async () => {
    const file = path.join(dir, "ten.txt");
    await writeFile(file, "abcdefghij");
    const truncated = await readTextFile(file, { maxBytes: 4 });
    expect(truncated).toEqual({ text: "abcd", bytes: 4, truncated: true });

    const full = await readTextFile(file);
    expect(full).toEqual({ text: "abcdefghij", bytes: 10, truncated: false });
  });
});
