import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { normalizeMcpServerUrl } from "./server-url.js";

describe("normalizeMcpServerUrl", () => {
  it.each([
    ["https://infoqast.com", "https://infoqast.com/mcp"],
    ["https://infoqast.com/mcp/", "https://infoqast.com/mcp"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/mcp"],
    ["http://[::1]:3000/mcp", "http://[::1]:3000/mcp"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeMcpServerUrl(raw).toString()).toBe(expected);
  });

  it.each([
    "http://example.test/mcp",
    "ftp://example.test/mcp",
    "https://user:password@example.test/mcp",
    "https://example.test/mcp?token=secret",
    "https://example.test/mcp#fragment",
    "https://example.test/api/mcp",
    "https://0.0.0.0/mcp",
    "https://10.0.0.1/mcp",
    "https://169.254.169.254/mcp",
    "https://192.168.1.20/mcp",
    "https://198.51.100.20/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://2130706433/mcp",
    "https://0x7f000001/mcp",
    "http://127.1/mcp",
    "https://0177.0.0.1/mcp",
    "http://localhost:3000/mcp",
    "https://attacker.example/mcp",
    "https://infoqast.com.attacker.example/mcp",
    "https://infoqast.com:444/mcp",
    "https://8.8.8.8/mcp",
  ])("rejects unsafe endpoint %s", (raw) => {
    expect(() => normalizeMcpServerUrl(raw)).toThrowError(CliError);
  });
});
