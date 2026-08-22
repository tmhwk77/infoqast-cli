import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "./credential-store.js";
import { EndpointPolicy } from "./endpoint-policy.js";
import { CliError } from "./errors.js";
import { FileOAuthProvider, INFOQAST_OAUTH_SCOPE } from "./oauth-provider.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "infoqast-oauth-provider-"));
  roots.push(root);
  const server = new URL("https://infoqast.com/mcp");
  const store = new CredentialStore(server, root);
  const redirectUrl = new URL("http://127.0.0.1:54321/oauth/callback");
  const onRedirect = vi.fn(async () => undefined);
  return {
    store,
    redirectUrl,
    onRedirect,
    provider: new FileOAuthProvider(
      store,
      redirectUrl,
      onRedirect,
      new EndpointPolicy(server, async () => [{ address: "8.8.8.8", family: 4 }]),
    ),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileOAuthProvider", () => {
  it("persists DCR, redirect, PKCE, state, tokens and discovery per server", async () => {
    const { provider, store, redirectUrl } = await fixture();
    expect(provider.clientMetadata).toMatchObject({
      client_name: "InfoQast CLI",
      redirect_uris: [redirectUrl.toString()],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: INFOQAST_OAUTH_SCOPE,
    });

    const state = await provider.state();
    expect(state).toHaveLength(43);
    await provider.saveClientInformation({
      client_id: "client-1",
      redirect_uris: [redirectUrl.toString()],
      token_endpoint_auth_method: "none",
    });
    await provider.saveCodeVerifier("v".repeat(43));
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://infoqast.com/api/auth",
    });
    expect(await provider.codeVerifier()).toBe("v".repeat(43));
    expect(await provider.clientInformation()).toMatchObject({
      client_id: "client-1",
      redirect_uris: [redirectUrl.toString()],
    });
    expect((await store.load()).redirectUrl).toBe(redirectUrl.toString());

    await provider.saveTokens({
      access_token: "access-token",
      token_type: "bearer",
      expires_in: 900,
    });
    expect(await provider.tokens()).toMatchObject({
      access_token: "access-token",
    });
    expect(await store.load()).not.toHaveProperty("codeVerifier");
    expect(await store.load()).not.toHaveProperty("oauthState");
  });

  it("accepts only the exact resource and clears credential subsets", async () => {
    const { provider, store, redirectUrl } = await fixture();
    await provider.saveClientInformation({ client_id: "client-1" });
    await provider.saveTokens({
      access_token: "access-token",
      token_type: "bearer",
      expires_in: 900,
    });
    await expect(
      provider.validateResourceURL("https://infoqast.com/mcp", "https://infoqast.com/mcp"),
    ).resolves.toEqual(new URL("https://infoqast.com/mcp"));
    await expect(
      provider.validateResourceURL("https://infoqast.com/mcp", "https://attacker.example/mcp"),
    ).rejects.toBeInstanceOf(CliError);

    await provider.invalidateCredentials("client");
    expect(await store.load()).not.toHaveProperty("clientInformation");
    expect(await store.load()).not.toHaveProperty("redirectUrl");
    expect(await store.load()).toHaveProperty("tokens");
    expect(redirectUrl.pathname).toBe("/oauth/callback");
  });

  it("fails closed when a server tries to issue a refresh token", async () => {
    const { provider, store } = await fixture();
    await expect(
      provider.saveTokens({
        access_token: "access-token",
        refresh_token: "unexpected-refresh-token",
        token_type: "bearer",
        expires_in: 900,
      }),
    ).rejects.toMatchObject({
      code: "unexpected_refresh_token",
    });
    expect(await store.load()).not.toHaveProperty("tokens");
  });

  it("removes a legacy refresh credential before the MCP SDK can use it", async () => {
    const { provider, store } = await fixture();
    await store.save({
      version: 1,
      server: store.server.toString(),
      tokens: {
        access_token: "legacy-access-token",
        refresh_token: "legacy-refresh-token",
        token_type: "bearer",
        expires_in: 900,
      },
      tokensSavedAt: new Date().toISOString(),
    });

    await expect(provider.tokens()).resolves.toBeUndefined();
    expect(await store.load()).not.toHaveProperty("tokens");
    expect(await store.load()).not.toHaveProperty("tokensSavedAt");
  });

  it("rejects poisoned discovery state before persistence or reuse", async () => {
    const { provider, store } = await fixture();
    const valid = {
      authorizationServerUrl: "https://infoqast.com/api/auth",
      authorizationServerMetadata: {
        issuer: "https://infoqast.com/api/auth",
        authorization_endpoint: "https://infoqast.com/api/auth/oauth2/authorize",
        token_endpoint: "https://infoqast.com/api/auth/oauth2/token",
        registration_endpoint: "https://infoqast.com/api/auth/oauth2/register",
        response_types_supported: ["code"],
      },
    };
    await expect(provider.saveDiscoveryState(valid)).resolves.toEqual(undefined);

    await expect(
      provider.saveDiscoveryState({
        ...valid,
        authorizationServerUrl: "http://127.0.0.1:3000/api/auth",
      }),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
    expect((await store.load()).discovery).toEqual(valid);

    await store.update((state) => ({
      ...state,
      discovery: {
        ...valid,
        authorizationServerMetadata: {
          ...valid.authorizationServerMetadata,
          token_endpoint: "file:///etc/passwd",
        },
      },
    }));
    await expect(provider.discoveryState()).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
  });

  it("validates the browser authorization URL before invoking an OS handler", async () => {
    const { provider, onRedirect } = await fixture();
    const valid = new URL(
      "https://infoqast.com/api/auth/oauth2/authorize?client_id=cli&state=opaque",
    );

    await expect(provider.redirectToAuthorization(valid)).resolves.toEqual(undefined);
    expect(onRedirect).toHaveBeenCalledOnce();
    await expect(
      provider.redirectToAuthorization(new URL("file:///Applications/Calculator.app")),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
    await expect(
      provider.redirectToAuthorization(
        new URL("http://127.0.0.1:3000/steal?client_id=cli&state=opaque"),
      ),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
    expect(onRedirect).toHaveBeenCalledOnce();
  });
});
