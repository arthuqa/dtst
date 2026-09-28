/**
 * Prompt construction: shared by every backend and by the CLI.
 */

import { badInput } from "@dtst/internal";

export const MAX_PROMPT_CHARS = 30_000;

export interface PromptParts {
  prompt: string;
  style?: string | undefined;
  negativePrompt?: string | undefined;
  instructions?: string | undefined;
}

export function buildPrompt(parts: PromptParts): string {
  const segments: string[] = [normalizePrompt(parts.prompt)];
  if (parts.style?.trim()) segments.push(`Style: ${parts.style.trim()}`);
  if (parts.negativePrompt?.trim()) segments.push(`Avoid: ${parts.negativePrompt.trim()}`);
  if (parts.instructions?.trim()) segments.push(parts.instructions.trim());
  return segments.join("\n\n");
}

export function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw badInput("`prompt` must not be empty.", "Describe the image you want, e.g. \"a red panda astronaut, studio light\".");
  }
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw badInput(`\`prompt\` is ${trimmed.length} characters; the maximum is ${MAX_PROMPT_CHARS}.`);
  }
  return trimmed;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "with", "and", "or", "for", "to", "from", "by", "into", "over",
  "ultra", "very", "highly", "detailed", "photo", "photograph", "image", "picture", "render", "realistic",
]);

/** Deterministic, filesystem-safe file name derived from the prompt. */
export function filenameFromPrompt(prompt: string, fallback = "image"): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, 6)
    .join("-");
  return (slug || fallback).slice(0, 60);
}

export function timestampSlug(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Append style/negative hints for backends without dedicated fields. */
export function composeChatPrompt(parts: PromptParts): string {
  const segments = [normalizePrompt(parts.prompt)];
  if (parts.style?.trim()) segments.push(`Style: ${parts.style.trim()}`);
  if (parts.negativePrompt?.trim()) segments.push(`Do not include: ${parts.negativePrompt.trim()}`);
  segments.push("Return the image only, without commentary.");
  return segments.join("\n");
}
