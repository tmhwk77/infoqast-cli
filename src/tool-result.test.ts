import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { accessTokenIsFresh, mcpToolRequestOptions, storedLoopbackRedirect } from "./mcp-client.js";
import { parseMcpToolResult } from "./tool-result.js";

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

describe("MCP CLI result boundary", () => {
  it("uses finite per-call timeouts below the HTTP edge timeout", () => {
    expect(mcpToolRequestOptions("list_brands")).toEqual({
      timeout: 30_000,
      maxTotalTimeout: 30_000,
    });
    expect(mcpToolRequestOptions("create_draft_from_brief")).toEqual({
      timeout: 65_000,
      maxTotalTimeout: 65_000,
    });
  });

  it("reuses a fresh token only with a previously validated loopback redirect", () => {
    expect(
      accessTokenIsFresh({
        version: 1,
        server: "https://infoqast.com/mcp",
        tokens: {
          access_token: "access-token",
          token_type: "bearer",
          expires_in: 900,
        },
        tokensSavedAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(
      accessTokenIsFresh({
        version: 1,
        server: "https://infoqast.com/mcp",
        tokens: {
          access_token: "legacy-access-token",
          refresh_token: "legacy-refresh-token",
          token_type: "bearer",
          expires_in: 900,
        },
        tokensSavedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(
      accessTokenIsFresh({
        version: 1,
        server: "https://infoqast.com/mcp",
        tokens: {
          access_token: "expired-access-token",
          token_type: "bearer",
          expires_in: 900,
        },
        tokensSavedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
      }),
    ).toBe(false);
    expect(storedLoopbackRedirect("http://127.0.0.1:54321/oauth/callback")?.toString()).toBe(
      "http://127.0.0.1:54321/oauth/callback",
    );
    expect(storedLoopbackRedirect("https://attacker.example/oauth/callback")).toBeNull();
    expect(storedLoopbackRedirect("http://127.0.0.1:54321/other")).toBeNull();
    expect(storedLoopbackRedirect("http://127.0.0.1/oauth/callback")).toBeNull();
  });

  it("accepts the bounded list-brands v1 shape", () => {
    expect(
      parseMcpToolResult(
        "list_brands",
        result({
          ok: true,
          workspace: { slug: "agency", name: "Agency", role: "OWNER" },
          brands: [
            {
              id: "brand-id",
              slug: "brand",
              name: "Brand",
              status: "active",
              default_language: "en",
              timezone: "Europe/London",
            },
          ],
          truncated: false,
        }),
      ),
    ).toMatchObject({ ok: true, truncated: false });
  });

  it("rejects shape drift, too many rows, and oversized payloads", () => {
    const baseBrand = {
      id: "brand-id",
      slug: "brand",
      name: "Brand",
      status: "active",
      default_language: "en",
      timezone: "Europe/London",
    };
    expect(() =>
      parseMcpToolResult(
        "list_brands",
        result({
          ok: true,
          workspace: { slug: "agency", name: "Agency", role: "OWNER" },
          brands: Array.from({ length: 101 }, (_, index) => ({
            ...baseBrand,
            id: `brand-${index}`,
          })),
          truncated: true,
        }),
      ),
    ).toThrowError(CliError);
    expect(() =>
      parseMcpToolResult(
        "list_brands",
        result({
          ok: true,
          workspace: { slug: "agency", name: "Agency", role: "OWNER" },
          brands: [],
          truncated: false,
          unexpected: "schema drift",
        }),
      ),
    ).toThrowError(CliError);
    expect(() =>
      parseMcpToolResult(
        "list_brands",
        result({
          ok: true,
          workspace: {
            slug: "agency",
            name: "x".repeat(1_024 * 1_024),
            role: "OWNER",
          },
          brands: [],
          truncated: false,
        }),
      ),
    ).toThrowError(CliError);
  });

  it("accepts only bounded stable domain failures", () => {
    expect(
      parseMcpToolResult(
        "create_draft_from_brief",
        result(
          {
            ok: false,
            code: "forbidden",
            message: "A live BYO connection is required.",
          },
          true,
        ),
      ),
    ).toEqual({
      ok: false,
      code: "forbidden",
      message: "A live BYO connection is required.",
    });
    expect(() =>
      parseMcpToolResult(
        "create_draft_from_brief",
        result(
          {
            ok: false,
            code: "forbidden;rm",
            message: "unsafe",
          },
          true,
        ),
      ),
    ).toThrowError(CliError);
  });
});
