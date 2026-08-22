import { mkdtemp, rm, stat } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "./credential-store.js";
import { revokeAndClear } from "./mcp-client.js";
import { runCli } from "./main.js";

const roots: string[] = [];
const LOOPBACK_ORIGIN = "http://127.0.0.1:54321";

async function storeWithLegacyRefreshToken() {
  const root = await mkdtemp(join(tmpdir(), "infoqast-cli-revoke-"));
  roots.push(root);
  const store = new CredentialStore(new URL(`${LOOPBACK_ORIGIN}/mcp`), root);
  await store.save({
    version: 1,
    server: store.server.toString(),
    clientInformation: { client_id: "public-client-1" },
    tokens: {
      access_token: "access-token-secret",
      refresh_token: "refresh-token-secret",
      token_type: "bearer",
      expires_in: 900,
    },
    tokensSavedAt: new Date().toISOString(),
    discovery: {
      authorizationServerUrl: `${LOOPBACK_ORIGIN}/api/auth`,
      authorizationServerMetadata: {
        issuer: `${LOOPBACK_ORIGIN}/api/auth`,
        authorization_endpoint: `${LOOPBACK_ORIGIN}/api/auth/oauth2/authorize`,
        token_endpoint: `${LOOPBACK_ORIGIN}/api/auth/oauth2/token`,
        revocation_endpoint: `${LOOPBACK_ORIGIN}/api/auth/oauth2/revoke`,
        response_types_supported: ["code"],
      },
    },
  });
  return { root, store };
}

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

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("revokeAndClear", () => {
  it("clears a legacy refresh credential only after confirmed server revocation", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeAndClear(store)).resolves.toEqual({
      local_cleared: true,
      server_revoked: true,
      warning: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, options] = fetchMock.mock.calls[0]!;
    expect(endpoint).toEqual(new URL(`${LOOPBACK_ORIGIN}/api/auth/oauth2/revoke`));
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = options!.body as URLSearchParams;
    expect(body.get("token")).toBe("refresh-token-secret");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("public-client-1");
    expect(await store.load()).toEqual({
      version: 1,
      server: `${LOOPBACK_ORIGIN}/mcp`,
    });
  });

  it("keeps a mode-0600 credential and returns a retryable error on timeout", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("request timed out with secret details", "AbortError");
      }),
    );

    await expect(revokeAndClear(store)).rejects.toMatchObject({
      code: "revocation_retryable",
      exitCode: 5,
      message: "Remote revocation could not be confirmed. Credentials were kept for retry.",
    });
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
    if (process.platform !== "win32") {
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("returns non-zero JSON and preserves retry state after HTTP 500", async () => {
    const { root, store } = await storeWithLegacyRefreshToken();
    vi.stubEnv("INFOQAST_CONFIG_DIR", root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const stdout = capture();
    const stderr = capture();

    const exit = await runCli(
      ["logout", "--server", store.server.toString(), "--json"],
      { stdout: stdout.stream, stderr: stderr.stream },
      process.env,
    );

    expect(exit).toBe(5);
    expect(JSON.parse(stdout.value())).toEqual({
      ok: false,
      code: "revocation_retryable",
      message: "Remote revocation could not be confirmed. Credentials were kept for retry.",
    });
    expect(stderr.value()).toBe("");
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
    if (process.platform !== "win32") {
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps a remote token when revocation metadata is incomplete", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    await store.update((state) => ({ ...state, discovery: undefined }));

    await expect(revokeAndClear(store)).rejects.toMatchObject({
      code: "revocation_unavailable",
      exitCode: 10,
    });
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
  });

  it("does not clear credentials after a non-retryable revocation rejection", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 400 })),
    );

    await expect(revokeAndClear(store)).rejects.toMatchObject({
      code: "revocation_failed",
      exitCode: 10,
      message: "Remote revocation was rejected. Credentials were kept for recovery.",
    });
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
  });

  it("rejects a poisoned cached revocation endpoint without issuing a request", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    await store.update((state) => ({
      ...state,
      discovery: {
        ...state.discovery!,
        authorizationServerMetadata: {
          ...state.discovery!.authorizationServerMetadata!,
          revocation_endpoint: "file:///etc/passwd",
        },
      },
    }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeAndClear(store)).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
  });

  it("rejects an HTTP revocation redirect and preserves the credential", async () => {
    const { store } = await storeWithLegacyRefreshToken();
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeAndClear(store)).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await store.load()).tokens?.refresh_token).toBe("refresh-token-secret");
  });
});
