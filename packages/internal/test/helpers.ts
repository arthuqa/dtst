/**
 * Test helpers shared by the @dtst/internal suites.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DtstError, isDtstError, type Logger } from "@dtst/internal";

export function be32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** Build a structurally valid (but not decodable) PNG with the given size. */
export function makePng(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.concat([
    be32(width),
    be32(height),
    Buffer.from([8, 6, 0, 0, 0]),
    be32(0),
  ]);
  const ihdr = Buffer.concat([Buffer.from("IHDR", "ascii"), ihdrData]);
  const idat = Buffer.concat([Buffer.from("IDAT", "ascii"), Buffer.from([1, 2, 3, 4]), be32(0)]);
  const iend = Buffer.concat([Buffer.from("IEND", "ascii"), be32(0)]);
  return Buffer.concat([signature, be32(ihdrData.length), ihdr, be32(4), idat, be32(0), iend]);
}

export async function makeTempDir(prefix = "dtst-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Run `fn` and return the DtstError it threw (fails the test otherwise). */
export function catchDtstError(fn: () => unknown): DtstError {
  try {
    fn();
  } catch (error) {
    if (!isDtstError(error)) throw error;
    return error;
  }
  throw new Error("expected the call to throw a DtstError");
}

/** Minimal logger that records nothing, for backend/operation tests. */
export function silentLogger(): Logger {
  const log: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}
