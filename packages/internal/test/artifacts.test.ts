import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_URI_PREFIX, ArtifactStore, fileUri } from "@dtst/internal";

describe("ArtifactStore", () => {
  it("saves, gets and lists artifacts", () => {
    const store = new ArtifactStore();
    const first = store.save({ path: "/tmp/a.txt", kind: "text", bytes: 5, mimeType: "text/plain", label: "a.txt", text: "hello" });
    const second = store.save({ path: "/tmp/b.png", kind: "image", bytes: 10 });

    expect(first.uri).toBe(`${ARTIFACT_URI_PREFIX}${first.id}`);
    expect(first.path).toBe(path.resolve("/tmp/a.txt"));
    expect(store.get(first.id)).toBe(first);
    expect(store.get("missing")).toBeUndefined();
    expect(store.list().map((artifact) => artifact.id)).toEqual([first.id, second.id]);

    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("resolves dtst://, artifact://, file:// and bare paths", () => {
    const store = new ArtifactStore();
    const artifact = store.save({ path: "/tmp/ref.txt", kind: "text", bytes: 1 });

    expect(store.resolve(artifact.uri)).toBe(artifact);
    expect(store.resolve(`artifact://${artifact.id}`)).toBe(artifact);
    expect(store.resolve(`artifact:///${artifact.id}`)).toBe(artifact);
    expect(store.resolve(fileUri("/tmp/ref.txt"))).toBe(artifact);
    expect(store.resolve("/tmp/ref.txt")).toBe(artifact);
  });

  it("returns undefined for unknown ids and empty references", () => {
    const store = new ArtifactStore();
    expect(store.resolve("dtst://artifact/deadbeef")).toBeUndefined();
    expect(store.resolve("   ")).toBeUndefined();
  });
});
