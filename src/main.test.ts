import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "./main.js";

function capture() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

describe("runCli offline commands", () => {
  it("reports the MCP URL and OAuth contract as JSON", async () => {
    const stdout = capture();
    const stderr = capture();
    const exit = await runCli(
      ["mcp-url", "--json"],
      { stdout: stdout.stream, stderr: stderr.stream },
      {},
    );

    expect(exit).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual({
      ok: true,
      command: "mcp-url",
      mcp_url: "https://infoqast.com/mcp",
      oauth: "authorization_code_s256_pkce",
      scopes: ["mcp:read", "mcp:draft"],
    });
    expect(stderr.value()).toBe("");
  });

  it("uses a stable usage exit and machine-readable error", async () => {
    const stdout = capture();
    const stderr = capture();
    const exit = await runCli(
      ["brands", "--workspace", "../escape", "--json"],
      { stdout: stdout.stream, stderr: stderr.stream },
      {},
    );

    expect(exit).toBe(2);
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: false,
      code: "usage_error",
    });
    expect(stderr.value()).toBe("");
  });
});
