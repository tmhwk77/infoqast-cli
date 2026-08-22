import type { CliCommand } from "./args.js";

export const VERSION = "0.1.0-beta.1";

export function safeTerminalText(value: unknown, maxLength = 1_000): string {
  return String(value)
    .slice(0, maxLength)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
}

export function helpText(command?: string): string {
  if (command === "draft") {
    return `Usage: infoqast draft --workspace <slug> --brand <slug> --message <brief> --platform <name> [options]

Creates and generates a reviewable draft. This can consume configured BYO AI usage.
Open Beta platforms: telegram, bluesky.
Options: --title, --goal, --cta, repeated --platform, --idempotency-key, --json, --server.`;
  }
  return `InfoQast CLI ${VERSION} — tenant-safe customer automation over MCP

Usage:
  infoqast login [--server <url>]
  infoqast logout [--server <url>]
  infoqast brands --workspace <slug>
  infoqast approvals --workspace <slug> [--brand <slug>] [--limit 1..50]
  infoqast performance --workspace <slug> [--days 7|30|90]
  infoqast draft --workspace <slug> --brand <slug> --message <brief> --platform <name>
  infoqast mcp-url

Global options:
  --server <url>  Official MCP URL, or literal loopback for development
  --json          Machine-readable output
  --help          Help
  --version       Version

Exit codes:
  0 success; 2 usage; 3 authentication; 4 access/not found;
  5 retry/rate/idempotency; 10 service/network.

This CLI cannot publish, schedule, approve, delete, export, administer users,
or read credentials. Run "infoqast draft --help" for draft safety details.`;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export function humanOutput(command: CliCommand, value: Record<string, unknown>): string {
  if (command.name === "login") return `Connected to ${command.server.toString()}`;
  if (command.name === "logout") {
    const warning = typeof value.warning === "string" ? `\nWarning: ${value.warning}` : "";
    return `Local credentials cleared. Remote revocation: ${
      value.server_revoked ? "confirmed" : "not confirmed"
    }.${warning}`;
  }
  if (command.name === "mcp-url") {
    return `MCP URL: ${command.server.toString()}\nOAuth: discovery + Authorization Code with S256 PKCE`;
  }
  if (command.name === "brands") {
    const brands = array(value.brands);
    if (brands.length === 0) return "No visible brands.";
    return brands
      .map(
        (brand) =>
          `${safeTerminalText(brand.slug)}\t${safeTerminalText(
            brand.name,
          )}\t${safeTerminalText(brand.status)}`,
      )
      .join("\n");
  }
  if (command.name === "approvals") {
    const items = array(value.items);
    if (items.length === 0) return "Approval queue is empty.";
    return items
      .map((item) => {
        const brand = object(item.brand);
        return `${safeTerminalText(item.variant_id)}\t${safeTerminalText(
          brand.slug,
        )}\t${safeTerminalText(item.platform)}\t${safeTerminalText(
          item.approval_status,
        )}\t${safeTerminalText(item.title ?? "")}`;
      })
      .join("\n");
  }
  if (command.name === "performance") {
    const summary = object(value.summary);
    const engagement = object(value.engagement);
    return [
      `Published variants: ${safeTerminalText(summary.publishedVariants ?? 0)}`,
      `Awaiting review: ${safeTerminalText(summary.awaitingReviewNow ?? 0)}`,
      `Needs attention: ${safeTerminalText(summary.needsAttentionNow ?? 0)}`,
      `Measured engagement: ${safeTerminalText(engagement.total ?? 0)}`,
    ].join("\n");
  }
  if (command.name === "draft") {
    const generation = object(value.generation);
    return [
      `Draft: ${safeTerminalText(value.content_item_id)}`,
      `Status: ${safeTerminalText(value.status)}`,
      `Generation: ${generation.completed ? "completed" : "needs attention"}`,
      `Review: ${safeTerminalText(value.review_url, 2_048)}`,
      `Idempotency key: ${safeTerminalText(value.idempotency_key)}`,
    ].join("\n");
  }
  return JSON.stringify(value, null, 2);
}
