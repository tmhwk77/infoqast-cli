import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { CliError, EXIT_CODES } from "./errors.js";

type PendingCallback = {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  expectedState: string;
};

function sameState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateOAuthCallback(
  rawUrl: string,
  redirectUrl: URL,
  expectedState: string,
):
  { kind: "success"; code: string } | { kind: "failure"; denied: boolean } | { kind: "not_found" } {
  let url: URL;
  try {
    url = new URL(rawUrl, redirectUrl);
  } catch {
    return { kind: "not_found" };
  }
  if (url.pathname !== redirectUrl.pathname) return { kind: "not_found" };
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (
    error ||
    !code ||
    code.length > 2_048 ||
    !sameState(url.searchParams.get("state"), expectedState)
  ) {
    return { kind: "failure", denied: Boolean(error) };
  }
  return { kind: "success", code };
}

export class OAuthLoopbackCallback {
  private pending: PendingCallback | null = null;

  private constructor(
    private readonly server: Server,
    readonly redirectUrl: URL,
  ) {}

  static async start(): Promise<OAuthLoopbackCallback> {
    let instance: OAuthLoopbackCallback | null = null;
    const server = createServer((request, response) => {
      if (!instance) {
        response.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("OAuth callback is not ready.");
        return;
      }
      instance.handle(request.url ?? "", response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new CliError(
        "Could not bind the OAuth callback.",
        EXIT_CODES.authentication,
        "callback_failed",
      );
    }
    instance = new OAuthLoopbackCallback(
      server,
      new URL(`http://127.0.0.1:${address.port}/oauth/callback`),
    );
    return instance;
  }

  private handle(rawUrl: string, response: import("node:http").ServerResponse) {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (!this.pending) {
      response.writeHead(404, headers).end("Not found.");
      return;
    }
    const result = validateOAuthCallback(rawUrl, this.redirectUrl, this.pending.expectedState);
    if (result.kind === "not_found") {
      response.writeHead(404, headers).end("Not found.");
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (result.kind === "failure") {
      response
        .writeHead(400, headers)
        .end("<h1>InfoQast authorization failed</h1><p>Return to the terminal.</p>");
      pending.reject(
        new CliError(
          result.denied ? "OAuth authorization was denied." : "OAuth callback validation failed.",
          EXIT_CODES.authentication,
          "authorization_failed",
        ),
      );
      return;
    }
    response
      .writeHead(200, headers)
      .end(
        "<h1>InfoQast connected</h1><p>You can close this window and return to the terminal.</p>",
      );
    pending.resolve(result.code);
  }

  waitForCode(expectedState: string, timeoutMs = 5 * 60_000): Promise<string> {
    if (this.pending) {
      throw new CliError(
        "An OAuth callback is already pending.",
        EXIT_CODES.authentication,
        "callback_failed",
      );
    }
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null;
        reject(
          new CliError(
            "OAuth authorization timed out.",
            EXIT_CODES.authentication,
            "authorization_timeout",
          ),
        );
      }, timeoutMs);
      timeout.unref();
      this.pending = {
        expectedState,
        resolve: (code) => {
          clearTimeout(timeout);
          resolve(code);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });
  }

  async close(): Promise<void> {
    this.pending?.reject(
      new CliError("OAuth callback closed.", EXIT_CODES.authentication, "callback_failed"),
    );
    this.pending = null;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
