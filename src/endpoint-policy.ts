import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CliError, EXIT_CODES } from "./errors.js";

const MAX_ENDPOINT_LENGTH = 2_048;
export const OFFICIAL_MCP_ORIGIN = "https://infoqast.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const loopbackIPv4 = new BlockList();
loopbackIPv4.addSubnet("127.0.0.0", 8, "ipv4");

const forbiddenIPv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  forbiddenIPv4.addSubnet(network, prefix, "ipv4");
}

const loopbackIPv6 = new BlockList();
loopbackIPv6.addAddress("::1", "ipv6");

const forbiddenIPv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 3],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["4000::", 2],
  ["5f00::", 16],
  ["8000::", 1],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  forbiddenIPv6.addSubnet(network, prefix, "ipv6");
}

type ResolvedAddress = { address: string; family: number };
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const defaultResolver: AddressResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function unsafeEndpoint(message: string): CliError {
  return new CliError(message, EXIT_CODES.authentication, "unsafe_oauth_endpoint");
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function rawHostname(value: string): string | null {
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::\d*)?(?:[/?#]|$)/iu.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function usesCanonicalIpLiteral(raw: string, url: URL): boolean {
  const canonical = url.hostname.toLowerCase();
  if (!isIP(unbracket(canonical))) return true;
  return rawHostname(raw) === canonical;
}

function addressClass(address: string): "loopback" | "forbidden" | "public" {
  const family = isIP(address);
  if (family === 4) {
    if (loopbackIPv4.check(address, "ipv4")) return "loopback";
    return forbiddenIPv4.check(address, "ipv4") ? "forbidden" : "public";
  }
  if (family === 6) {
    if (loopbackIPv6.check(address, "ipv6")) return "loopback";
    return forbiddenIPv6.check(address, "ipv6") ? "forbidden" : "public";
  }
  return "forbidden";
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function assertSafeServerLiteral(url: URL, raw = url.toString()): void {
  const hostname = unbracket(url.hostname);
  if (!hostname) {
    throw new CliError("Invalid MCP server URL.", EXIT_CODES.usage, "invalid_server");
  }
  if (!usesCanonicalIpLiteral(raw, url)) {
    throw new CliError(
      "The MCP server must use a canonical IP address.",
      EXIT_CODES.usage,
      "invalid_server",
    );
  }
  if (!isIP(hostname)) return;
  const classification = addressClass(hostname);
  if (classification !== "public" && !isLoopbackHostname(url.hostname)) {
    throw new CliError(
      "The MCP server cannot use a private, reserved, or link-local destination.",
      EXIT_CODES.usage,
      "invalid_server",
    );
  }
}

function parseEndpoint(value: string | URL): URL {
  const raw = value.toString();
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH) {
    throw unsafeEndpoint("The OAuth server returned an invalid endpoint.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafeEndpoint("The OAuth server returned an invalid endpoint.");
  }
  if (!usesCanonicalIpLiteral(raw, url)) {
    throw unsafeEndpoint("The OAuth server returned a non-canonical IP endpoint.");
  }
  if (url.username || url.password || url.hash) {
    throw unsafeEndpoint("The OAuth server returned an unsafe endpoint.");
  }
  return url;
}

const AUTHORIZATION_METADATA_ENDPOINTS = [
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
  "revocation_endpoint",
  "introspection_endpoint",
  "jwks_uri",
  "pushed_authorization_request_endpoint",
  "device_authorization_endpoint",
  "end_session_endpoint",
] as const;

/**
 * One trust boundary for every URL learned during the native OAuth flow.
 * InfoQast intentionally serves MCP and OAuth from one origin, so discovery
 * cannot delegate the CLI to an unrelated identity provider or network host.
 */
export class EndpointPolicy {
  readonly fetch: FetchLike;
  private readonly serverIsLoopback: boolean;

  constructor(
    readonly server: URL,
    private readonly resolver: AddressResolver = defaultResolver,
    private readonly baseFetch: FetchLike = globalThis.fetch as FetchLike,
  ) {
    const serverIsLoopback = isLoopbackHostname(server.hostname);
    if (
      (server.protocol !== "https:" && !(server.protocol === "http:" && serverIsLoopback)) ||
      server.username ||
      server.password ||
      server.search ||
      server.hash ||
      server.pathname !== "/mcp" ||
      (!serverIsLoopback && server.origin !== OFFICIAL_MCP_ORIGIN)
    ) {
      throw unsafeEndpoint("The MCP server is outside the allowed network boundary.");
    }
    assertSafeServerLiteral(server);
    this.serverIsLoopback = serverIsLoopback;
    this.fetch = async (input, init) => {
      const endpoint = await this.validateEndpoint(input);
      const response = await this.baseFetch(endpoint, { ...init, redirect: "manual" });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw unsafeEndpoint("OAuth and MCP HTTP redirects are not allowed.");
      }
      return response;
    };
  }

  async validateServer(): Promise<void> {
    await this.validateEndpoint(this.server);
  }

  async validateEndpoint(value: string | URL): Promise<URL> {
    const url = parseEndpoint(value);
    if (url.origin !== this.server.origin) {
      throw unsafeEndpoint("OAuth endpoints must use the requested MCP server origin.");
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && this.serverIsLoopback && isLoopbackHostname(url.hostname))
    ) {
      throw unsafeEndpoint("OAuth endpoints must use HTTPS outside loopback development.");
    }
    await this.validateDestination(url.hostname);
    return url;
  }

  async validateAuthorizationUrl(value: string | URL): Promise<URL> {
    return this.validateEndpoint(value);
  }

  async validateDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const authorizationServer = await this.validateEndpoint(state.authorizationServerUrl);
    if (authorizationServer.search || authorizationServer.hash) {
      throw unsafeEndpoint("The OAuth issuer URL is invalid.");
    }

    if (state.resourceMetadataUrl) {
      await this.validateEndpoint(state.resourceMetadataUrl);
    }
    const authorizationServers = state.resourceMetadata?.authorization_servers;
    if (authorizationServers) {
      for (const value of authorizationServers) await this.validateEndpoint(value);
    }

    const metadata = state.authorizationServerMetadata;
    if (!metadata) return;
    if (typeof metadata.issuer !== "string") {
      throw unsafeEndpoint("OAuth metadata does not identify its issuer.");
    }
    const issuer = await this.validateEndpoint(metadata.issuer);
    if (issuer.search || issuer.hash || issuer.toString() !== authorizationServer.toString()) {
      throw unsafeEndpoint(
        "OAuth metadata issuer does not match the discovered authorization server.",
      );
    }
    const metadataRecord = metadata as unknown as Record<string, unknown>;
    for (const name of AUTHORIZATION_METADATA_ENDPOINTS) {
      const value = metadataRecord[name];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw unsafeEndpoint(`OAuth metadata contains an invalid ${name}.`);
      }
      await this.validateEndpoint(value);
    }
  }

  private async validateDestination(rawHostname: string): Promise<void> {
    const hostname = unbracket(rawHostname).toLowerCase();
    let addresses: readonly ResolvedAddress[];
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      addresses = [{ address: hostname, family: literalFamily }];
    } else {
      try {
        addresses = await this.resolver(hostname);
      } catch {
        throw unsafeEndpoint("The OAuth endpoint destination could not be verified.");
      }
    }
    if (addresses.length === 0) {
      throw unsafeEndpoint("The OAuth endpoint destination could not be verified.");
    }
    const classes = addresses.map(({ address }) => addressClass(address));
    if (this.serverIsLoopback) {
      if (classes.some((value) => value !== "loopback")) {
        throw unsafeEndpoint("A loopback MCP server must resolve only to loopback addresses.");
      }
      return;
    }
    if (classes.some((value) => value !== "public")) {
      throw unsafeEndpoint(
        "OAuth endpoints cannot resolve to private, reserved, or link-local addresses.",
      );
    }
  }
}
