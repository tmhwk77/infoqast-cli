import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore } from "./credential-store.js";
import { CliError } from "./errors.js";

const roots: string[] = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "infoqast-cli-test-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  for (const value of roots.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(value, { recursive: true, force: true }));
  }
});

describe("CredentialStore", () => {
  it("stores separate server state using restrictive permissions", async () => {
    const configRoot = await root();
    const first = new CredentialStore(new URL("https://one.test/mcp"), configRoot);
    const second = new CredentialStore(new URL("https://two.test/mcp"), configRoot);

    expect(first.path).not.toBe(second.path);
    await first.save({
      version: 1,
      server: first.server.toString(),
      tokens: { access_token: "access-token-value", token_type: "bearer" },
      tokensSavedAt: new Date().toISOString(),
    });

    expect((await first.load()).tokens?.access_token).toBe("access-token-value");
    expect(await second.load()).toEqual({
      version: 1,
      server: "https://two.test/mcp",
    });
    if (process.platform !== "win32") {
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);
      expect((await stat(configRoot)).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(first.path, "utf8")).not.toContain("two.test");
  });

  it("rejects credentials copied from a different server", async () => {
    const configRoot = await root();
    const store = new CredentialStore(new URL("https://one.test/mcp"), configRoot);
    await store.save({
      version: 1,
      server: "https://one.test/mcp",
    });
    const data = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    data.server = "https://other.test/mcp";
    await writeFile(store.path, JSON.stringify(data), { mode: 0o600 });

    await expect(store.load()).rejects.toBeInstanceOf(CliError);
  });

  it.runIf(process.platform !== "win32")(
    "rejects credentials readable by another user",
    async () => {
      const configRoot = await root();
      const store = new CredentialStore(new URL("https://one.test/mcp"), configRoot);
      await store.save({ version: 1, server: store.server.toString() });
      await chmod(store.path, 0o644);

      await expect(store.load()).rejects.toMatchObject({
        code: "invalid_credentials",
      });
    },
  );
});
