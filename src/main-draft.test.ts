import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./mcp-client.js", () => ({
  defaultAuthorizationOpener: () => async () => undefined,
  InfoQastMcpConnection: { connect: mocks.connect },
  revokeAndClear: vi.fn(),
}));

import { runCli } from "./main.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({
    callTool: mocks.callTool,
    close: mocks.close,
  });
});

describe("draft output contract", () => {
  it("keeps JSON stdout parseable and stderr empty", async () => {
    mocks.callTool.mockResolvedValue({
      content: [],
      structuredContent: {
        ok: true,
        replayed: false,
        content_item_id: "item-1",
        review_url: "https://infoqast.com/w/agency/b/brand/c/item-1",
        status: "review",
        generation: { completed: true, error: null },
        variants: [],
      },
    });
    const stdout = capture();
    const stderr = capture();
    const exit = await runCli(
      [
        "draft",
        "--workspace",
        "agency",
        "--brand",
        "brand",
        "--message",
        "Announce the beta launch",
        "--platform",
        "telegram",
        "--idempotency-key",
        "launch-001",
        "--json",
      ],
      { stdout: stdout.stream, stderr: stderr.stream },
      {},
    );

    expect(exit).toBe(0);
    expect(stderr.value()).toBe("");
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      command: "draft",
      content_item_id: "item-1",
      idempotency_key: "launch-001",
    });
    expect(mocks.callTool).toHaveBeenCalledWith("create_draft_from_brief", {
      workspace_slug: "agency",
      brand_slug: "brand",
      idempotency_key: "launch-001",
      core_message: "Announce the beta launch",
      goal: "announcement",
      platforms: ["telegram"],
    });
  });
});
