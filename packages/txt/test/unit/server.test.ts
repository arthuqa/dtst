import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactStore } from "@dtst/internal";
import { SERVER_INSTRUCTIONS, createTxtServer } from "../../src/server";
import { makeConfig } from "./helpers";

describe("createTxtServer", () => {
  it("builds an McpServer without connecting a transport", () => {
    const config = makeConfig();
    const artifacts = new ArtifactStore();
    const bundle = createTxtServer({ config, artifacts });

    expect(bundle.server).toBeInstanceOf(McpServer);
    expect(bundle.artifacts).toBe(artifacts);
    expect(typeof bundle.log.info).toBe("function");
    expect(bundle.server.isConnected()).toBe(false);
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  it("documents the required configuration and headline tools", () => {
    for (const needle of ["OPENAI_BASE_URL", "OPENAI_MODEL", "read_context", "write_text", "images"]) {
      expect(SERVER_INSTRUCTIONS).toContain(needle);
    }
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
  });
});
