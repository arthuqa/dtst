import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planOutput, resolvePath, slug, writeOutput } from "../src/files";
import { tempDir } from "./helpers";

describe("resolvePath", () => {
  it("resolves relative, absolute and ~ paths", () => {
    expect(resolvePath("a/b.png", "/root")).toBe("/root/a/b.png");
    expect(resolvePath("/abs/x", "/root")).toBe("/abs/x");
    expect(resolvePath("~/x", "/root")).toBe(path.join(os.homedir(), "x"));
    expect(() => resolvePath("  ", "/root")).toThrow(/empty/);
  });
});

describe("slug", () => {
  it("keeps up to six meaningful words", () => {
    expect(slug("A red panda astronaut, in the studio with soft light!", "image")).toBe(
      "red-panda-astronaut-studio-soft-light",
    );
    expect(slug("!!!", "image")).toBe("image");
  });
});

describe("planOutput", () => {
  it("treats existing folders and trailing slashes as directories", async () => {
    const root = tempDir();
    mkdirSync(path.join(root, "art"));
    expect(await planOutput("art", root, "name")).toEqual({ dir: path.join(root, "art"), base: "name" });
    expect(await planOutput("new/", root, "name")).toEqual({ dir: path.join(root, "new"), base: "name" });
    expect(await planOutput(undefined, root, "name")).toEqual({ dir: root, base: "name" });
  });

  it("splits a file path into dir, base and extension", async () => {
    const root = tempDir();
    expect(await planOutput("out/hero.PNG", root, "x")).toEqual({
      dir: path.join(root, "out"),
      base: "hero",
      extension: ".png",
    });
  });
});

describe("writeOutput", () => {
  it("never clobbers by default and numbers collisions", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "a.png"), "old");
    const first = await writeOutput({ dir, base: "a" }, ".png", "new");
    const second = await writeOutput({ dir, base: "a" }, ".png", "newer");
    expect([path.basename(first), path.basename(second)]).toEqual(["a-1.png", "a-2.png"]);
    expect(readFileSync(path.join(dir, "a.png"), "utf8")).toBe("old");
  });

  it("numbers batches from 1 and skips taken numbers", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "b-1.png"), "taken");
    const names = [];
    for (const index of [1, 2])
      names.push(path.basename(await writeOutput({ dir, base: "b" }, ".png", "x", { index })));
    expect(names).toEqual(["b-2.png", "b-3.png"]);
  });

  it("overwrites when asked, creates folders, leaves no temp files", async () => {
    const dir = path.join(tempDir(), "deep", "er");
    await writeOutput({ dir, base: "c" }, ".txt", "one");
    const file = await writeOutput({ dir, base: "c" }, ".txt", "two", { overwrite: true });
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["c.txt"]);
  });
});
