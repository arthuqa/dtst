/** Private runtime shared by @dtst/img, @dtst/txt and @dtst/tts; inlined into each bundle by tsup. */

export * from "./config";
export * from "./errors";
export * from "./files";
export * from "./http";
export * from "./log";
export * from "./mime";
export * from "./server";
export * from "./sources";

declare const __DTST_VERSION__: string | undefined;
export const VERSION: string = typeof __DTST_VERSION__ === "string" ? __DTST_VERSION__ : "0.0.0-dev";
