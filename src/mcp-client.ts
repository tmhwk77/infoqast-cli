import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError, type AuthResult } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CredentialStore } from "./credential-store.js";
import { EndpointPolicy } from "./endpoint-policy.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { OAuthLoopbackCallback } from "./oauth-callback.js";
import { FileOAuthProvider, INFOQAST_OAUTH_SCOPE } from "./oauth-provider.js";
import type { CliToolName } from "./tool-result.js";

const CLI_VERSION = "0.1.0-beta.1";
const READ_TOOL_TIMEOUT_MS = 30_000;
const DRAFT_TOOL_TIMEOUT_MS = 65_000;

export type AuthorizationOpener = (url: URL) => Promise<void>;

export function mcpToolRequestOptions(name: CliToolName) {
  const timeout = name === "create_draft_from_brief" ? DRAFT_TOOL_TIMEOUT_MS : READ_TOOL_TIMEOUT_MS;
  return { timeout, maxTotalTimeout: timeout };
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function defaultAuthorizationOpener(stderr: NodeJS.WritableStream): AuthorizationOpener {
  return async (url) => {
    stderr.write(`Open this URL to authorize InfoQast:\n${url.toString()}\n`);
    try {
      if (process.platform === "darwin") await spawnDetached("open", [url.toString()]);
      else await spawnDetached("xdg-open", [url.toString()]);
    } catch {
      stderr.write("Could not open a browser automatically; open the URL above manually.\n");
    }
  };
}

export function accessTokenIsFresh(state: Awaited<ReturnType<CredentialStore["load"]>>): boolean {
  if (
    !state.tokens?.access_token ||
    state.tokens.refresh_token ||
    !state.tokensSavedAt ||
    !state.tokens.expires_in
  ) {
    return false;
  }
  const savedAt = Date.parse(state.tokensSavedAt);
  return (
    Number.isFinite(savedAt) && savedAt + state.tokens.expires_in * 1_000 > Date.now() + 60_000
  );
}

export function storedLoopbackRedirect(value: string | undefined): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      url.protocol !== "http:" ||
      !loopback ||
      !url.port ||
      url.pathname !== "/oauth/callback" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function ensureAuthorization(params: {
  server: URL;
  store: CredentialStore;
  callback: OAuthLoopbackCallback;
  opener: AuthorizationOpener;
  endpointPolicy: EndpointPolicy;
}): Promise<FileOAuthProvider> {
  let authorizationUrl: URL | null = null;
  const provider = new FileOAuthProvider(
    params.store,
    params.callback.redirectUrl,
    async (url) => {
      authorizationUrl = url;
    },
    params.endpointPolicy,
  );
  if (accessTokenIsFresh(await params.store.load())) return provider;

  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", params.server);
  let result: AuthResult;
  try {
    result = await auth(provider, {
      serverUrl: params.server,
      scope: INFOQAST_OAUTH_SCOPE,
      resourceMetadataUrl,
      fetchFn: params.endpointPolicy.fetch,
    });
  } catch {
    throw new CliError(
      "OAuth discovery or authorization failed. Verify the MCP URL and try login again.",
      EXIT_CODES.authentication,
      "authentication_failed",
    );
  }
  if (result === "AUTHORIZED") return provider;
  if (!authorizationUrl) {
    throw new CliError(
      "The authorization server did not return a login URL.",
      EXIT_CODES.authentication,
      "authentication_failed",
    );
  }

  const codePromise = params.callback.waitForCode(provider.expectedState());
  let code: string;
  try {
    await params.opener(authorizationUrl);
    code = await codePromise;
  } catch {
    void codePromise.catch(() => undefined);
    throw new CliError(
      "OAuth browser authorization could not start. Open the displayed URL manually or retry.",
      EXIT_CODES.authentication,
      "authentication_failed",
    );
  }
  try {
    const completed = await auth(provider, {
      serverUrl: params.server,
      authorizationCode: code,
      scope: INFOQAST_OAUTH_SCOPE,
      resourceMetadataUrl,
      fetchFn: params.endpointPolicy.fetch,
    });
    if (completed !== "AUTHORIZED") throw new Error("authorization did not complete");
  } catch {
    throw new CliError(
      "OAuth token exchange failed. Authorization may have expired; run login again.",
      EXIT_CODES.authentication,
      "authentication_failed",
    );
  }
  return provider;
}

export class InfoQastMcpConnection {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async connect(params: {
    server: URL;
    store?: CredentialStore;
    opener: AuthorizationOpener;
  }): Promise<InfoQastMcpConnection> {
    const endpointPolicy = new EndpointPolicy(params.server);
    await endpointPolicy.validateServer();
    const store = params.store ?? new CredentialStore(params.server);
    const savedState = await store.load();
    const savedRedirect = storedLoopbackRedirect(savedState.redirectUrl);
    let callback: OAuthLoopbackCallback | null = null;
    try {
      let provider: FileOAuthProvider;
      if (accessTokenIsFresh(savedState) && savedRedirect) {
        provider = new FileOAuthProvider(
          store,
          savedRedirect,
          async () => {
            throw new CliError(
              "Authorization was rejected or expired. Run infoqast login again.",
              EXIT_CODES.authentication,
              "authentication_failed",
            );
          },
          endpointPolicy,
        );
      } else {
        callback = await OAuthLoopbackCallback.start();
        provider = await ensureAuthorization({
          server: params.server,
          store,
          callback,
          opener: params.opener,
          endpointPolicy,
        });
      }
      const client = new Client(
        { name: "infoqast-cli", version: CLI_VERSION },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(params.server, {
        authProvider: provider,
        fetch: endpointPolicy.fetch,
      });
      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        if (error instanceof UnauthorizedError) {
          await provider.invalidateCredentials("tokens");
          throw new CliError(
            "Authorization was rejected or revoked. Run infoqast login again.",
            EXIT_CODES.authentication,
            "authentication_failed",
          );
        }
        throw error;
      }
      return new InfoQastMcpConnection(client, transport);
    } finally {
      await callback?.close();
    }
  }

  async callTool(name: CliToolName, args: Record<string, unknown>): Promise<CallToolResult> {
    return CallToolResultSchema.parse(
      await this.client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
        mcpToolRequestOptions(name),
      ),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close().catch(() => undefined);
  }
}

export async function revokeAndClear(store: CredentialStore): Promise<{
  local_cleared: boolean;
  server_revoked: boolean;
  warning: string | null;
}> {
  const state = await store.load();
  // Compatibility cleanup for credentials created during pre-release
  // development. The Open Beta authorization flow never requests or accepts a
  // refresh token, and FileOAuthProvider never exposes one to the MCP SDK.
  const legacyRefreshToken = state.tokens?.refresh_token;
  const token = legacyRefreshToken ?? state.tokens?.access_token;
  const clientInformation = state.clientInformation;
  const clientId = clientInformation?.client_id;
  const metadata = state.discovery?.authorizationServerMetadata;
  const endpoint =
    metadata &&
    "revocation_endpoint" in metadata &&
    typeof metadata.revocation_endpoint === "string"
      ? metadata.revocation_endpoint
      : undefined;

  if (!token) {
    return {
      local_cleared: await store.clear(),
      server_revoked: false,
      warning: null,
    };
  }
  if (!clientId || !endpoint) {
    throw new CliError(
      "Remote revocation is unavailable because OAuth metadata is incomplete. Credentials were kept for recovery.",
      EXIT_CODES.service,
      "revocation_unavailable",
    );
  }
  const endpointPolicy = new EndpointPolicy(store.server);
  await endpointPolicy.validateServer();
  if (state.discovery) await endpointPolicy.validateDiscoveryState(state.discovery);

  const body = new URLSearchParams({
    token,
    token_type_hint: legacyRefreshToken ? "refresh_token" : "access_token",
    client_id: clientId,
  });
  if (
    clientInformation &&
    "client_secret" in clientInformation &&
    typeof clientInformation.client_secret === "string"
  ) {
    body.set("client_secret", clientInformation.client_secret);
  }

  let response: Response;
  try {
    response = await endpointPolicy.fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "Remote revocation could not be confirmed. Credentials were kept for retry.",
      EXIT_CODES.retryable,
      "revocation_retryable",
    );
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new CliError(
      retryable
        ? "Remote revocation could not be confirmed. Credentials were kept for retry."
        : "Remote revocation was rejected. Credentials were kept for recovery.",
      retryable ? EXIT_CODES.retryable : EXIT_CODES.service,
      retryable ? "revocation_retryable" : "revocation_failed",
    );
  }

  return {
    local_cleared: await store.clear(),
    server_revoked: true,
    warning: null,
  };
}
