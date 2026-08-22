import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseCliArgs, type CliCommand } from "./args.js";
import { CredentialStore } from "./credential-store.js";
import { asCliError, CliError, EXIT_CODES, type ExitCode } from "./errors.js";
import {
  defaultAuthorizationOpener,
  InfoQastMcpConnection,
  revokeAndClear,
  type AuthorizationOpener,
} from "./mcp-client.js";
import { helpText, humanOutput, safeTerminalText, VERSION } from "./output.js";
import { parseMcpToolResult, type CliToolName } from "./tool-result.js";

export type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

function domainError(value: Record<string, unknown>): CliError {
  const code = typeof value.code === "string" ? value.code : "service_error";
  const message =
    typeof value.message === "string" ? value.message.slice(0, 500) : "The MCP tool failed.";
  if (code === "forbidden" || code === "not_found") {
    return new CliError(message, EXIT_CODES.access, code);
  }
  if (
    code === "rate_limited" ||
    code === "idempotency_conflict" ||
    code === "idempotency_in_progress"
  ) {
    return new CliError(message, EXIT_CODES.retryable, code);
  }
  return new CliError(message, EXIT_CODES.service, code);
}

function toolValue(name: CliToolName, result: CallToolResult): Record<string, unknown> {
  const value = parseMcpToolResult(name, result);
  if (result.isError) throw domainError(value);
  return value;
}

async function withConnection(
  command: Extract<
    CliCommand,
    { name: "login" | "brands" | "approvals" | "performance" | "draft" }
  >,
  opener: AuthorizationOpener,
  operation: (connection: InfoQastMcpConnection) => Promise<Record<string, unknown>>,
) {
  const connection = await InfoQastMcpConnection.connect({
    server: command.server,
    opener,
  });
  try {
    return await operation(connection);
  } finally {
    await connection.close();
  }
}

async function execute(
  command: CliCommand,
  io: CliIo,
  opener: AuthorizationOpener,
): Promise<Record<string, unknown>> {
  if (command.name === "help") return { text: helpText(command.command) };
  if (command.name === "version") return { text: VERSION };
  if (command.name === "mcp-url") {
    return {
      mcp_url: command.server.toString(),
      oauth: "authorization_code_s256_pkce",
      scopes: ["mcp:read", "mcp:draft"],
    };
  }
  if (command.name === "logout") {
    return revokeAndClear(new CredentialStore(command.server));
  }
  if (command.name === "login") {
    return withConnection(command, opener, async () => ({
      connected: true,
      server: command.server.toString(),
    }));
  }
  if (command.name === "brands") {
    return withConnection(command, opener, async (connection) =>
      toolValue(
        "list_brands",
        await connection.callTool("list_brands", {
          workspace_slug: command.workspace,
        }),
      ),
    );
  }
  if (command.name === "approvals") {
    return withConnection(command, opener, async (connection) =>
      toolValue(
        "get_approval_queue",
        await connection.callTool("get_approval_queue", {
          workspace_slug: command.workspace,
          limit: command.limit,
          ...(command.brand ? { brand_slug: command.brand } : {}),
        }),
      ),
    );
  }
  if (command.name === "performance") {
    return withConnection(command, opener, async (connection) =>
      toolValue(
        "get_performance_summary",
        await connection.callTool("get_performance_summary", {
          workspace_slug: command.workspace,
          days: command.days,
        }),
      ),
    );
  }

  const idempotencyKey = command.idempotencyKey ?? randomUUID();
  return withConnection(command, opener, async (connection) => {
    const value = toolValue(
      "create_draft_from_brief",
      await connection.callTool("create_draft_from_brief", {
        workspace_slug: command.workspace,
        brand_slug: command.brand,
        idempotency_key: idempotencyKey,
        core_message: command.message,
        goal: command.goal,
        platforms: command.platforms,
        ...(command.title ? { title: command.title } : {}),
        ...(command.cta ? { cta: command.cta } : {}),
      }),
    );
    return { ...value, idempotency_key: idempotencyKey };
  });
}

export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
  opener: AuthorizationOpener = defaultAuthorizationOpener(io.stderr),
): Promise<ExitCode> {
  let command: CliCommand | null = null;
  try {
    command = parseCliArgs(argv, env);
    const result = await execute(command, io, opener);
    if (command.name === "help" || command.name === "version") {
      io.stdout.write(`${String(result.text)}\n`);
    } else if (command.json) {
      io.stdout.write(`${JSON.stringify({ ok: true, command: command.name, ...result })}\n`);
    } else {
      io.stdout.write(`${humanOutput(command, result)}\n`);
    }
    return EXIT_CODES.success;
  } catch (error) {
    const safe = asCliError(error);
    const json = command ? "json" in command && command.json : argv.includes("--json");
    if (json) {
      io.stdout.write(`${JSON.stringify({ ok: false, code: safe.code, message: safe.message })}\n`);
    } else {
      io.stderr.write(`Error: ${safeTerminalText(safe.message, 1_000)}\n`);
    }
    return safe.exitCode;
  }
}
