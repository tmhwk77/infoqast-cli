import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CliError, EXIT_CODES } from "./errors.js";

export type CliToolName =
  "list_brands" | "get_approval_queue" | "get_performance_summary" | "create_draft_from_brief";

const MAX_RESULT_BYTES = 1_024 * 1_024;
const boundedText = z.string().max(1_000);
const id = z.string().min(1).max(200);
const slug = z.string().min(1).max(80);
const errorResult = z
  .object({
    ok: z.literal(false),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/),
    message: z.string().min(1).max(500),
    content_item_id: id.optional(),
  })
  .strict();

const schemas: Record<CliToolName, z.ZodType<Record<string, unknown>>> = {
  list_brands: z
    .object({
      ok: z.literal(true),
      workspace: z
        .object({
          slug,
          name: z.string().min(1).max(200),
          role: z.string().min(1).max(80),
        })
        .strict(),
      brands: z
        .array(
          z
            .object({
              id,
              slug,
              name: z.string().min(1).max(200),
              status: z.string().min(1).max(80),
              default_language: z.string().min(1).max(40),
              timezone: z.string().min(1).max(100),
            })
            .strict(),
        )
        .max(100),
      truncated: z.boolean(),
    })
    .strict(),
  get_approval_queue: z
    .object({
      ok: z.literal(true),
      items: z
        .array(
          z
            .object({
              variant_id: id,
              content_item_id: id,
              brand: z
                .object({
                  slug,
                  name: z.string().min(1).max(200),
                })
                .strict(),
              platform: z.string().min(1).max(40),
              title: z.string().max(120).nullable(),
              caption_preview: boundedText,
              caption_truncated: z.boolean(),
              approval_status: z.string().min(1).max(40),
              updated_at: z.string().datetime(),
            })
            .strict(),
        )
        .max(50),
      truncated: z.boolean(),
    })
    .strict(),
  get_performance_summary: z
    .object({
      ok: z.literal(true),
      period: z
        .object({
          days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
          from: z.string().datetime(),
          to: z.string().datetime(),
        })
        .strict(),
      summary: z
        .record(z.string().max(80), z.number().finite().nullable())
        .refine((value) => Object.keys(value).length <= 40),
      engagement: z
        .record(z.string().max(80), z.union([z.number().finite(), z.string().max(100), z.null()]))
        .refine((value) => Object.keys(value).length <= 40),
      brands: z
        .array(
          z
            .record(
              z.string().max(80),
              z.union([z.string().max(500), z.number().finite(), z.null()]),
            )
            .refine((value) => Object.keys(value).length <= 40),
        )
        .max(100),
      platforms: z
        .array(
          z
            .record(
              z.string().max(80),
              z.union([z.string().max(500), z.number().finite(), z.null()]),
            )
            .refine((value) => Object.keys(value).length <= 40),
        )
        .max(20),
      truncated: z.boolean(),
    })
    .strict(),
  create_draft_from_brief: z
    .object({
      ok: z.literal(true),
      replayed: z.boolean(),
      content_item_id: id,
      review_url: z.string().url().max(2_048),
      status: z.string().min(1).max(80),
      generation: z
        .object({
          completed: z.boolean(),
          error: z.string().max(500).nullable(),
        })
        .strict(),
      variants: z
        .array(
          z
            .object({
              id,
              platform: z.string().min(1).max(40),
              approval_status: z.string().min(1).max(40),
              caption_preview: boundedText,
              caption_truncated: z.boolean(),
            })
            .strict(),
        )
        .max(6),
    })
    .strict(),
};

function invalidResult(): CliError {
  return new CliError(
    "The MCP server returned an invalid or oversized structured result.",
    EXIT_CODES.service,
    "invalid_result",
  );
}

function boundedJsonSize(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_RESULT_BYTES;
  } catch {
    return false;
  }
}

export function parseMcpToolResult(
  name: CliToolName,
  result: CallToolResult,
): Record<string, unknown> {
  if (!boundedJsonSize(result)) throw invalidResult();
  let value =
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null &&
    !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : null;
  if (!value) {
    const text = result.content.find((item) => item.type === "text");
    if (text?.type === "text" && Buffer.byteLength(text.text) <= MAX_RESULT_BYTES) {
      try {
        const parsed: unknown = JSON.parse(text.text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          value = parsed as Record<string, unknown>;
        }
      } catch {
        throw invalidResult();
      }
    }
  }
  if (!value) throw invalidResult();
  const parsed = (result.isError ? errorResult : schemas[name]).safeParse(value);
  if (!parsed.success) throw invalidResult();
  return parsed.data;
}
