import { CliError, EXIT_CODES } from "./errors.js";
import {
  assertSafeServerLiteral,
  isLoopbackHostname,
  OFFICIAL_MCP_ORIGIN,
} from "./endpoint-policy.js";

export function normalizeMcpServerUrl(raw: string): URL {
  if (!raw || raw.length > 2_048) {
    throw new CliError("Invalid MCP server URL.", EXIT_CODES.usage, "invalid_server");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("Invalid MCP server URL.", EXIT_CODES.usage, "invalid_server");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(
      "The MCP server URL cannot contain credentials, a query, or a fragment.",
      EXIT_CODES.usage,
      "invalid_server",
    );
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError(
      "The MCP server must use HTTPS (HTTP is allowed only on loopback).",
      EXIT_CODES.usage,
      "invalid_server",
    );
  }
  if (!loopback && url.origin !== OFFICIAL_MCP_ORIGIN) {
    throw new CliError(
      "The Open Beta CLI connects remotely only to https://infoqast.com.",
      EXIT_CODES.usage,
      "invalid_server",
    );
  }
  assertSafeServerLiteral(url, raw);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") url.pathname = "/mcp";
  else if (path === "/mcp") url.pathname = "/mcp";
  else {
    throw new CliError("The MCP server URL path must be /mcp.", EXIT_CODES.usage, "invalid_server");
  }
  return url;
}
