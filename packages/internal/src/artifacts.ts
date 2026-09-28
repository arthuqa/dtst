/**
 * In-process registry of files this server produced (images, text, downloads).
 *
 * Two jobs:
 *  1. Let a tool reference an earlier result (`dtst://artifact/<id>`) without
 *     the agent having to remember paths.
 *  2. Back the MCP resource template so clients can `resources/read` an
 *     artifact by URI.
 *
 * The registry is intentionally process-local and cheap; files on disk remain
 * the source of truth.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathFromFileUri } from "./paths";

export type ArtifactKind = "text" | "image" | "file";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** Absolute path on disk. */
  path: string;
  /** Canonical resource URI: `dtst://artifact/<id>`. */
  uri: string;
  mimeType?: string;
  bytes: number;
  createdAt: string;
  label?: string;
  /** Inline copy for small text artifacts, so reads never hit disk twice. */
  text?: string;
}

export interface ArtifactInput {
  path: string;
  kind: ArtifactKind;
  bytes: number;
  mimeType?: string;
  label?: string;
  text?: string;
}

export const ARTIFACT_URI_PREFIX = "dtst://artifact/";

export class ArtifactStore {
  private readonly items = new Map<string, Artifact>();

  save(input: ArtifactInput): Artifact {
    const id = randomBytes(6).toString("hex");
    const artifact: Artifact = {
      id,
      kind: input.kind,
      path: path.resolve(input.path),
      uri: `${ARTIFACT_URI_PREFIX}${id}`,
      bytes: input.bytes,
      createdAt: new Date().toISOString(),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.text === undefined ? {} : { text: input.text }),
    };
    this.items.set(id, artifact);
    return artifact;
  }

  get(id: string): Artifact | undefined {
    return this.items.get(id);
  }

  list(): Artifact[] {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  clear(): void {
    this.items.clear();
  }

  /** Resolve a `dtst://artifact/<id>` URI, a `file://` URI or a bare path. */
  resolve(reference: string): Artifact | undefined {
    const value = reference.trim();
    if (!value) return undefined;
    if (value.startsWith(ARTIFACT_URI_PREFIX)) return this.items.get(value.slice(ARTIFACT_URI_PREFIX.length));
    if (value.startsWith("artifact://")) {
      const id = value.slice("artifact://".length).replace(/^\/+/, "");
      return this.items.get(id);
    }
    const fromFileUri = pathFromFileUri(value);
    const candidate = path.resolve(fromFileUri ?? value);
    for (const artifact of this.items.values()) {
      if (artifact.path === candidate) return artifact;
    }
    return undefined;
  }
}
