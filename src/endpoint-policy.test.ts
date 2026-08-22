import { describe, expect, it, vi } from "vitest";
import { EndpointPolicy } from "./endpoint-policy.js";

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }] as const;

describe("EndpointPolicy", () => {
  it("allows one public HTTPS origin and disables redirect following", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const policy = new EndpointPolicy(
      new URL("https://infoqast.com/mcp"),
      publicResolver,
      fetchMock,
    );

    await expect(policy.validateServer()).resolves.toEqual(undefined);
    await expect(
      policy.fetch("https://infoqast.com/api/auth/oauth2/token", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("https://infoqast.com/api/auth/oauth2/token"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
  });

  it.each([
    "file:///etc/passwd",
    "http://127.0.0.1:3000/token",
    "https://169.254.169.254/latest/meta-data",
    "https://attacker.example/token",
    "https://user:password@infoqast.com/token",
    "https://infoqast.com/token#secret",
  ])("rejects an endpoint outside the requested server trust boundary: %s", async (endpoint) => {
    const policy = new EndpointPolicy(new URL("https://infoqast.com/mcp"), publicResolver);
    await expect(policy.validateEndpoint(endpoint)).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
  });

  it("rejects obfuscated IP literals before origin comparison or dispatch", async () => {
    const policy = new EndpointPolicy(new URL("http://127.0.0.1:3000/mcp"), async () => [
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(
      policy.validateEndpoint("http://2130706433:3000/api/auth/oauth2/token"),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
    await expect(
      policy.validateEndpoint("http://0x7f000001:3000/api/auth/oauth2/token"),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
  });

  it.each([
    { addresses: [{ address: "10.1.2.3", family: 4 }] },
    { addresses: [{ address: "169.254.169.254", family: 4 }] },
    { addresses: [{ address: "198.51.100.10", family: 4 }] },
    { addresses: [{ address: "fc00::1", family: 6 }] },
    { addresses: [{ address: "fe80::1", family: 6 }] },
    {
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    },
  ])("rejects non-public or mixed DNS answers: $addresses", async ({ addresses }) => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const policy = new EndpointPolicy(
      new URL("https://infoqast.com/mcp"),
      async () => addresses,
      fetchMock,
    );

    await expect(policy.validateServer()).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows HTTP loopback development only on literal addresses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const policy = new EndpointPolicy(
      new URL("http://127.0.0.1:3000/mcp"),
      async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ],
      fetchMock,
    );

    await expect(
      policy.validateAuthorizationUrl("http://127.0.0.1:3000/api/auth/oauth2/authorize?state=ok"),
    ).resolves.toBeInstanceOf(URL);

    expect(
      () =>
        new EndpointPolicy(
          new URL("http://localhost:3000/mcp"),
          async () => [{ address: "127.0.0.1", family: 4 }],
          fetchMock,
        ),
    ).toThrowError(
      expect.objectContaining({
        code: "unsafe_oauth_endpoint",
      }),
    );
  });

  it("rejects arbitrary remote origins before DNS or fetch can run", () => {
    const resolver = vi.fn(publicResolver);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

    expect(
      () =>
        new EndpointPolicy(new URL("https://attacker-controlled.example/mcp"), resolver, fetchMock),
    ).toThrowError(
      expect.objectContaining({
        code: "unsafe_oauth_endpoint",
      }),
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates official DNS before each dispatch and rejects a changed private answer", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }]);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const policy = new EndpointPolicy(new URL("https://infoqast.com/mcp"), resolver, fetchMock);

    await expect(policy.validateServer()).resolves.toEqual(undefined);
    await expect(policy.fetch("https://infoqast.com/api/auth/oauth2/token")).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects registration, token, MCP, and revocation redirects before following Location", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    const policy = new EndpointPolicy(
      new URL("https://infoqast.com/mcp"),
      publicResolver,
      fetchMock,
    );

    await expect(policy.fetch("https://infoqast.com/api/auth/oauth2/token")).rejects.toMatchObject({
      code: "unsafe_oauth_endpoint",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("binds metadata issuer and every actionable endpoint to the discovered server", async () => {
    const policy = new EndpointPolicy(new URL("https://infoqast.com/mcp"), publicResolver);
    const valid = {
      authorizationServerUrl: "https://infoqast.com/api/auth",
      authorizationServerMetadata: {
        issuer: "https://infoqast.com/api/auth",
        authorization_endpoint: "https://infoqast.com/api/auth/oauth2/authorize",
        token_endpoint: "https://infoqast.com/api/auth/oauth2/token",
        registration_endpoint: "https://infoqast.com/api/auth/oauth2/register",
        revocation_endpoint: "https://infoqast.com/api/auth/oauth2/revoke",
        response_types_supported: ["code"],
      },
    };

    await expect(policy.validateDiscoveryState(valid)).resolves.toEqual(undefined);
    await expect(
      policy.validateDiscoveryState({
        ...valid,
        authorizationServerMetadata: {
          ...valid.authorizationServerMetadata,
          issuer: "https://infoqast.com/api/other-issuer",
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
    await expect(
      policy.validateDiscoveryState({
        ...valid,
        authorizationServerMetadata: {
          ...valid.authorizationServerMetadata,
          registration_endpoint: "file:///tmp/register",
        },
      }),
    ).rejects.toMatchObject({ code: "unsafe_oauth_endpoint" });
  });
});
