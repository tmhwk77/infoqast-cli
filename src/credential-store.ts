import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod";
import { CliError, EXIT_CODES } from "./errors.js";

const MAX_CREDENTIAL_BYTES = 128 * 1_024;
const discoverySchema = z.record(z.string(), z.unknown());
const fileSchema = z.object({
  version: z.literal(1),
  server: z.string().url(),
  clientInformation: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  redirectUrl: z.string().url().optional(),
  tokens: OAuthTokensSchema.optional(),
  tokensSavedAt: z.string().datetime().optional(),
  codeVerifier: z.string().min(43).max(256).optional(),
  oauthState: z.string().min(20).max(256).optional(),
  discovery: discoverySchema.optional(),
});

export type CredentialState = {
  version: 1;
  server: string;
  clientInformation?: OAuthClientInformationMixed;
  redirectUrl?: string;
  tokens?: OAuthTokens;
  tokensSavedAt?: string;
  codeVerifier?: string;
  oauthState?: string;
  discovery?: OAuthDiscoveryState;
};

export function defaultConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INFOQAST_CONFIG_DIR) return env.INFOQAST_CONFIG_DIR;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "InfoQast");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "infoqast");
}

export class CredentialStore {
  readonly path: string;

  constructor(
    readonly server: URL,
    configRoot = defaultConfigRoot(),
  ) {
    const serverKey = createHash("sha256").update(server.toString()).digest("hex").slice(0, 24);
    this.path = join(configRoot, `credentials-${serverKey}.json`);
  }

  async load(): Promise<CredentialState> {
    try {
      const info = await stat(this.path);
      if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) {
        throw new CliError(
          "Credential file is invalid or too large.",
          EXIT_CODES.authentication,
          "invalid_credentials",
        );
      }
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new CliError(
          "Credential file permissions are too broad; expected mode 0600.",
          EXIT_CODES.authentication,
          "invalid_credentials",
        );
      }
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      if (!parsed.success || parsed.data.server !== this.server.toString()) {
        throw new CliError(
          "Credential file is invalid for this server.",
          EXIT_CODES.authentication,
          "invalid_credentials",
        );
      }
      return parsed.data as CredentialState;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, server: this.server.toString() };
      }
      if (error instanceof CliError) throw error;
      throw new CliError(
        "Could not read the credential file safely.",
        EXIT_CODES.authentication,
        "invalid_credentials",
      );
    }
  }

  async save(state: CredentialState): Promise<void> {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_BYTES) {
      throw new CliError(
        "Credential state is unexpectedly large.",
        EXIT_CODES.authentication,
        "invalid_credentials",
      );
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async update(update: (state: CredentialState) => CredentialState): Promise<void> {
    await this.save(update(await this.load()));
  }

  async clear(): Promise<boolean> {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }
}
