import { describe, expect, it } from "vitest";
import { humanOutput, safeTerminalText } from "./output.js";

describe("terminal output safety", () => {
  it("removes terminal controls and bidi overrides", () => {
    expect(safeTerminalText("safe\u001b[31m\nfake\u202e")).toBe("safe�[31m�fake�");
  });

  it("cannot turn untrusted approval titles into extra rows", () => {
    const output = humanOutput(
      {
        name: "approvals",
        server: new URL("https://infoqast.com/mcp"),
        json: false,
        workspace: "agency",
        limit: 20,
      },
      {
        items: [
          {
            variant_id: "variant-1",
            brand: { slug: "brand" },
            platform: "telegram",
            approval_status: "pending",
            title: "Title\nINJECTED\tCOLUMN\u001b[2J",
          },
        ],
      },
    );

    expect(output.split("\n")).toHaveLength(1);
    expect(output).not.toContain("\u001b");
    expect(output).toContain("Title�INJECTED�COLUMN�[2J");
  });
});
