import { describe, expect, it } from "vitest";
import { CliError, EXIT_CODES } from "./errors.js";
import { parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("returns the exact default MCP endpoint", () => {
    expect(parseCliArgs(["mcp-url", "--json"], {})).toMatchObject({
      name: "mcp-url",
      json: true,
      server: new URL("https://infoqast.com/mcp"),
    });
  });

  it("rejects a remote server override outside the beta InfoQast origin", () => {
    expect(() =>
      parseCliArgs(["login"], {
        INFOQAST_SERVER_URL: "https://attacker-controlled.example/mcp",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_server",
      }),
    );
  });

  it("parses a bounded draft with repeated beta platforms", () => {
    expect(
      parseCliArgs(
        [
          "draft",
          "--workspace",
          "agency-one",
          "--brand",
          "brand-one",
          "--message",
          "Announce the beta launch",
          "--platform",
          "telegram",
          "--platform",
          "bluesky",
          "--idempotency-key",
          "launch-001",
        ],
        {},
      ),
    ).toMatchObject({
      name: "draft",
      workspace: "agency-one",
      brand: "brand-one",
      message: "Announce the beta launch",
      platforms: ["telegram", "bluesky"],
      idempotencyKey: "launch-001",
    });
  });

  it.each([
    [
      ["draft", "--workspace", "agency", "--brand", "brand", "--message", "valid brief"],
      "missing platform",
    ],
    [
      [
        "draft",
        "--workspace",
        "agency",
        "--brand",
        "brand",
        "--message",
        "valid brief",
        "--platform",
        "telegram",
        "--platform",
        "telegram",
      ],
      "duplicate platform",
    ],
    [
      [
        "draft",
        "--workspace",
        "agency",
        "--brand",
        "brand",
        "--message",
        "valid brief",
        "--platform",
        "discord",
      ],
      "non-beta platform",
    ],
    [
      [
        "draft",
        "--workspace",
        "agency",
        "--brand",
        "brand",
        "--message",
        "valid brief",
        "--platform",
        "mastodon",
      ],
      "gated Mastodon platform",
    ],
    [["brands", "--workspace", "../other"], "invalid tenant slug"],
    [["performance", "--workspace", "agency", "--days", "365"], "invalid range"],
    [["login", "--workspace", "agency"], "command-specific flag"],
  ])("rejects %s (%s)", (argv) => {
    expect(() => parseCliArgs(argv, {})).toThrowError(CliError);
    try {
      parseCliArgs(argv, {});
    } catch (error) {
      expect(error).toMatchObject({ exitCode: EXIT_CODES.usage });
    }
  });
});
