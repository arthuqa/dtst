/** stderr-only logging: stdout belongs to the MCP JSON-RPC stream. Secrets are scrubbed. */

const secrets = new Set<string>();

export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 8) secrets.add(secret);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.replaceAll(secret, "«redacted»");
  return out;
}

const debugEnabled = (): boolean => /^(1|true|yes|on)$/i.test(process.env["DEBUG"]?.trim() ?? "");

function write(level: string, message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
  process.stderr.write(redact(`[dtst] ${level} ${message}${suffix}\n`));
}

export const log = {
  debug: (message: string, data?: unknown): void => {
    if (debugEnabled()) write("debug", message, data);
  },
  warn: (message: string, data?: unknown): void => write("warn", message, data),
  error: (message: string, data?: unknown): void => write("error", message, data),
};
