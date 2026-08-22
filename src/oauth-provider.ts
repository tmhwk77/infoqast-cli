import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { EndpointPolicy } from "./endpoint-policy.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { CredentialStore } from "./credential-store.js";

export const INFOQAST_OAUTH_SCOPE = "mcp:read mcp:draft";

type NativeOAuthClientMetadata = OAuthClientMetadata & { application_type: "native" };

export class FileOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: NativeOAuthClientMetadata;
  private readonly generatedState = randomBytes(32).toString("base64url");

  constructor(
    readonly store: CredentialStore,
    readonly redirectUrl: URL,
    private readonly onRedirect: (url: URL) => Promise<void>,
    private readonly endpointPolicy: EndpointPolicy,
  ) {
    this.clientMetadata = {
      client_name: "InfoQast CLI",
      client_uri: "https://infoqast.com",
      redirect_uris: [redirectUrl.toString()],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: INFOQAST_OAUTH_SCOPE,
    };
  }

  async state(): Promise<string> {
    await this.store.update((current) => ({ ...current, oauthState: this.generatedState }));
    return this.generatedState;
  }

  expectedState(): string {
    return this.generatedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.store.load()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.store.update((current) => ({
      ...current,
      clientInformation,
      redirectUrl: this.redirectUrl.toString(),
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = (await this.store.load()).tokens;
    if (tokens?.refresh_token) {
      await this.invalidateCredentials("tokens");
      return undefined;
    }
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (tokens.refresh_token) {
      throw new CliError(
        "The authorization server returned a refresh token that this Open Beta client does not accept.",
        EXIT_CODES.authentication,
        "unexpected_refresh_token",
      );
    }
    await this.store.update((current) => {
      const next = { ...current, tokens, tokensSavedAt: new Date().toISOString() };
      delete next.codeVerifier;
      delete next.oauthState;
      return next;
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.endpointPolicy.validateAuthorizationUrl(authorizationUrl);
    await this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.update((current) => ({ ...current, codeVerifier }));
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.load()).codeVerifier;
    if (!verifier) {
      throw new CliError(
        "The OAuth PKCE verifier is missing. Start login again.",
        EXIT_CODES.authentication,
        "missing_pkce_verifier",
      );
    }
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.endpointPolicy.validateDiscoveryState(discovery);
    await this.store.update((current) => ({ ...current, discovery }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const discovery = (await this.store.load()).discovery;
    if (discovery) await this.endpointPolicy.validateDiscoveryState(discovery);
    return discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await this.store.update((current) => {
      const next = { ...current };
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
        delete next.redirectUrl;
      }
      if (scope === "all" || scope === "tokens") delete next.tokens;
      if (scope === "all" || scope === "tokens") delete next.tokensSavedAt;
      if (scope === "all" || scope === "verifier") {
        delete next.codeVerifier;
        delete next.oauthState;
      }
      if (scope === "all" || scope === "discovery") delete next.discovery;
      return next;
    });
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    const expected = new URL(serverUrl);
    const selected = new URL(resource ?? expected);
    expected.hash = "";
    selected.hash = "";
    if (
      expected.toString() !== this.endpointPolicy.server.toString() ||
      selected.toString() !== expected.toString()
    ) {
      throw new CliError(
        "OAuth resource metadata does not match the requested MCP server.",
        EXIT_CODES.authentication,
        "resource_mismatch",
      );
    }
    await this.endpointPolicy.validateEndpoint(selected);
    return selected;
  }
}
