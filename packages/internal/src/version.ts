/**
 * Build-time identity. tsup replaces `__DTST_PACKAGE__` / `__DTST_VERSION__`
 * with the concrete package name and version from package.json.
 */

declare const __DTST_PACKAGE__: string | undefined;
declare const __DTST_VERSION__: string | undefined;

function readDefine(value: () => string, fallback: string): string {
  try {
    const resolved = value();
    return typeof resolved === "string" && resolved.length > 0 ? resolved : fallback;
  } catch {
    return fallback;
  }
}

export function packageName(): string {
  return readDefine(() => __DTST_PACKAGE__ as string, "@dtst/unknown");
}

export function packageVersion(): string {
  return readDefine(() => __DTST_VERSION__ as string, "0.0.0");
}

export function serverInfo(): { name: string; version: string } {
  return { name: packageName(), version: packageVersion() };
}
