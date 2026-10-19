/** Test doubles shared by all packages: a fake OpenAI-compatible provider and an in-memory MCP client. */

import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "../src/server";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  json?: any;
  form?: FormData;
}

export type Reply = { status?: number; json?: unknown; body?: Buffer | string; headers?: Record<string, string> };
export type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeProvider {
  url: string;
  requests: RecordedRequest[];
  /** Register a handler for `METHOD /path` (path relative to the API root, query ignored). */
  on(route: string, handler: Handler | Reply): void;
  close(): Promise<void>;
}

export async function fakeProvider(): Promise<FakeProvider> {
  const routes = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const route = (req.url ?? "/").replace(/^\/v1/, "").split("?")[0];
    const recorded: RecordedRequest = { method: req.method ?? "GET", path: route ?? "/", headers: req.headers };
    const type = req.headers["content-type"] ?? "";
    if (type.includes("application/json")) recorded.json = JSON.parse(raw.toString("utf8"));
    if (type.includes("multipart/form-data")) {
      recorded.form = await new Request("http://x", {
        method: "POST",
        body: raw,
        headers: { "content-type": type },
      }).formData();
    }
    requests.push(recorded);
    const handler = routes.get(`${recorded.method} ${recorded.path}`);
    const reply = handler ? await handler(recorded) : { status: 404, json: { error: { message: "No such route" } } };
    const body = reply.body ?? JSON.stringify(reply.json ?? {});
    res.writeHead(reply.status ?? 200, {
      "content-type": reply.body ? "application/octet-stream" : "application/json",
      ...reply.headers,
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    on: (route, handler) => routes.set(route, typeof handler === "function" ? handler : () => handler),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dtst-test-"));
}

/** Connect an in-memory MCP client; `root` is advertised through the roots capability. */
export async function connect(server: Server, options: { root?: string } = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: options.root ? { roots: {} } : {} });
  if (options.root) {
    const uri = pathToFileURL(options.root).href;
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri, name: "workspace" }] }));
  }
  await client.connect(clientTransport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
}

/** A valid 1×1 PNG and a 2×3 PNG header, for sniffing and dimension tests. */
export const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.from(PNG_1x1);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

export const WEBP_HEADER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(18),
]);
