import { describe, expect, it } from "vitest";
import { validateOAuthCallback } from "./oauth-callback.js";

describe("validateOAuthCallback", () => {
  const redirectUrl = new URL("http://127.0.0.1:54321/oauth/callback");

  it("accepts the exact path and matching state", () => {
    expect(
      validateOAuthCallback(
        "/oauth/callback?code=authorization-code&state=expected-state-value-123",
        redirectUrl,
        "expected-state-value-123",
      ),
    ).toEqual({ kind: "success", code: "authorization-code" });
  });

  it("rejects mismatched state, wrong path, denial, and oversized codes", () => {
    expect(
      validateOAuthCallback(
        "/oauth/callback?code=authorization-code&state=attacker-state-value",
        redirectUrl,
        "expected-state-value-123",
      ),
    ).toEqual({ kind: "failure", denied: false });
    expect(
      validateOAuthCallback(
        "/other?code=authorization-code&state=expected-state-value-123",
        redirectUrl,
        "expected-state-value-123",
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      validateOAuthCallback(
        "/oauth/callback?error=access_denied&state=expected-state-value-123",
        redirectUrl,
        "expected-state-value-123",
      ),
    ).toEqual({ kind: "failure", denied: true });
    expect(
      validateOAuthCallback(
        `/oauth/callback?code=${"a".repeat(2_049)}&state=expected-state-value-123`,
        redirectUrl,
        "expected-state-value-123",
      ),
    ).toEqual({ kind: "failure", denied: false });
  });
});
