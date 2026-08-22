import { z } from "zod";
import { CliError, EXIT_CODES } from "./errors.js";
import { normalizeMcpServerUrl } from "./server-url.js";

const DEFAULT_SERVER = "https://infoqast.com/mcp";
const betaPlatform = z.enum(["telegram", "bluesky"]);
const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export type CliCommand =
  | { name: "help"; command?: string }
  | { name: "version" }
  | { name: "login"; server: URL; json: boolean }
  | { name: "logout"; server: URL; json: boolean }
  | { name: "mcp-url"; server: URL; json: boolean }
  | { name: "brands"; server: URL; json: boolean; workspace: string }
  | {
      name: "approvals";
      server: URL;
      json: boolean;
      workspace: string;
      brand?: string;
      limit: number;
    }
  | {
      name: "performance";
      server: URL;
      json: boolean;
      workspace: string;
      days: 7 | 30 | 90;
    }
  | {
      name: "draft";
      server: URL;
      json: boolean;
      workspace: string;
      brand: string;
      message: string;
      title?: string;
      goal: "announcement" | "awareness" | "engagement" | "conversion";
      cta?: string;
      platforms: Array<z.infer<typeof betaPlatform>>;
      idempotencyKey?: string;
    };

const VALUE_FLAGS = new Set([
  "server",
  "workspace",
  "brand",
  "limit",
  "days",
  "message",
  "title",
  "goal",
  "cta",
  "platform",
  "idempotency-key",
]);
const GLOBAL_FLAGS = new Set(["server", "json", "help", "version"]);
const COMMAND_FLAGS: Record<string, Set<string>> = {
  login: new Set(),
  logout: new Set(),
  "mcp-url": new Set(),
  brands: new Set(["workspace"]),
  approvals: new Set(["workspace", "brand", "limit"]),
  performance: new Set(["workspace", "days"]),
  draft: new Set([
    "workspace",
    "brand",
    "message",
    "title",
    "goal",
    "cta",
    "platform",
    "idempotency-key",
  ]),
};

type Collected = {
  command?: string;
  flags: Map<string, string[]>;
};

function usage(message: string): never {
  throw new CliError(message, EXIT_CODES.usage, "usage_error");
}

function collect(argv: string[]): Collected {
  const flags = new Map<string, string[]>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      if (command) usage(`Unexpected argument: ${token}`);
      command = token;
      continue;
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? undefined : separator);
    if (!name) usage("Invalid empty flag.");
    if (!VALUE_FLAGS.has(name) && !["json", "help", "version"].includes(name)) {
      usage(`Unknown flag: --${name}`);
    }
    let value = "true";
    if (VALUE_FLAGS.has(name)) {
      value =
        separator === -1
          ? (argv[++index] ?? usage(`Missing value for --${name}`))
          : token.slice(separator + 1);
      if (!value || value.startsWith("--")) usage(`Missing value for --${name}`);
    } else if (separator !== -1) {
      usage(`--${name} does not accept a value`);
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (!values) return undefined;
  if (values.length !== 1) usage(`--${name} may be specified only once`);
  return values[0];
}

function required(flags: Map<string, string[]>, name: string): string {
  return one(flags, name) ?? usage(`Missing required --${name}`);
}

function assertAllowed(command: string, flags: Map<string, string[]>) {
  const allowed = new Set([...GLOBAL_FLAGS, ...(COMMAND_FLAGS[command] ?? [])]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) usage(`--${name} is not valid for ${command}`);
  }
}

function parseSlug(value: string, flag: string): string {
  const result = slug.safeParse(value);
  if (!result.success) usage(`--${flag} must be a lowercase slug`);
  return result.data;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  const { command, flags } = collect(argv);
  if (flags.has("version")) return { name: "version" };
  if (!command || flags.has("help")) return { name: "help", ...(command ? { command } : {}) };
  if (!(command in COMMAND_FLAGS)) usage(`Unknown command: ${command}`);
  assertAllowed(command, flags);

  const server = normalizeMcpServerUrl(
    one(flags, "server") ?? env.INFOQAST_SERVER_URL ?? DEFAULT_SERVER,
  );
  const json = flags.has("json");
  if (command === "login" || command === "logout" || command === "mcp-url") {
    return { name: command, server, json };
  }
  const workspace = parseSlug(required(flags, "workspace"), "workspace");
  if (command === "brands") return { name: "brands", server, json, workspace };
  if (command === "approvals") {
    const rawLimit = one(flags, "limit") ?? "20";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      usage("--limit must be an integer from 1 to 50");
    }
    const rawBrand = one(flags, "brand");
    return {
      name: "approvals",
      server,
      json,
      workspace,
      ...(rawBrand ? { brand: parseSlug(rawBrand, "brand") } : {}),
      limit,
    };
  }
  if (command === "performance") {
    const rawDays = Number(one(flags, "days") ?? "30");
    if (rawDays !== 7 && rawDays !== 30 && rawDays !== 90) {
      usage("--days must be 7, 30, or 90");
    }
    return { name: "performance", server, json, workspace, days: rawDays };
  }

  const parsed = z
    .object({
      brand: slug,
      message: z.string().trim().min(5).max(4_000),
      title: z.string().trim().min(1).max(120).optional(),
      goal: z
        .enum(["announcement", "awareness", "engagement", "conversion"])
        .default("announcement"),
      cta: z.string().trim().min(1).max(500).optional(),
      platforms: z
        .array(betaPlatform)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length),
      idempotencyKey: z
        .string()
        .trim()
        .min(8)
        .max(128)
        .regex(/^[A-Za-z0-9._~-]+$/)
        .optional(),
    })
    .safeParse({
      brand: required(flags, "brand"),
      message: required(flags, "message"),
      title: one(flags, "title"),
      goal: one(flags, "goal") ?? "announcement",
      cta: one(flags, "cta"),
      platforms: flags.get("platform") ?? [],
      idempotencyKey: one(flags, "idempotency-key"),
    });
  if (!parsed.success) usage(`Invalid draft arguments: ${z.prettifyError(parsed.error)}`);
  return {
    name: "draft",
    server,
    json,
    workspace,
    brand: parsed.data.brand,
    message: parsed.data.message,
    goal: parsed.data.goal,
    platforms: parsed.data.platforms,
    ...(parsed.data.title ? { title: parsed.data.title } : {}),
    ...(parsed.data.cta ? { cta: parsed.data.cta } : {}),
    ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
  };
}
