# Security

Do not open a public issue for vulnerabilities, credentials, authorization
codes, access tokens, customer content, or tenant identifiers.

Report security issues through [InfoQast Support](https://infoqast.com/support)
and include only the minimum reproduction needed. The CLI has no direct database
access; its supported production endpoint is `https://infoqast.com/mcp`.

The Open Beta CLI requests only `mcp:read` and, when needed, `mcp:draft`. It
does not request offline access or refresh tokens and cannot publish, approve,
schedule, delete, export, or administer content.
