export const EXIT_CODES = {
  success: 0,
  usage: 2,
  authentication: 3,
  access: 4,
  retryable: 5,
  service: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    "The MCP service or network request failed safely.",
    EXIT_CODES.service,
    "service_error",
  );
}
