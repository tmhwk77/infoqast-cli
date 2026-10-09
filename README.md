# InfoQast CLI

Public, MIT-licensed source for the bounded InfoQast customer MCP command-line
client. Version `0.1.0-beta.1` is a release candidate: it is not yet published
to npm and must not be described as generally available until the production
and registry gates pass.
The first Open Beta release is scoped to macOS and Linux; Windows credential
ACL/keychain support has not been accepted for this version.

After a verified public release, install the immutable version named in the
InfoQast release notes. The convenience command will be:

```bash
npx @infoqast/cli --help
```

The binary is `infoqast`. It uses OAuth 2.1 Authorization Code + S256 PKCE and
the remote Streamable HTTP MCP endpoint. It never connects to the InfoQast
database and does not expose publish, schedule, delete, export, credentials or
administrative operations.

The Open Beta contract uses a short-lived 15-minute access token and does not request
`offline_access` or a refresh token. After expiry, an interactive command opens
the browser PKCE login again. Persistent and non-interactive access are not part
of this release.

Available commands:

```text
infoqast login
infoqast logout
infoqast brands --workspace <slug>
infoqast approvals --workspace <slug>
infoqast performance --workspace <slug> [--days 7|30|90]
infoqast draft --workspace <slug> --brand <slug> --message <brief> \
  --platform telegram [--platform bluesky] [--idempotency-key <key>]
infoqast mcp-url
```

`draft` may call the workspace's configured AI provider and consume BYO AI
usage. It creates a reviewable draft only and cannot publish.

On macOS and Linux, credentials are stored per server in the OS user config
directory with file mode `0600` and directory mode `0700`. When a remote token
exists, `logout` removes the local credential file only after the OAuth server
confirms revocation. A timeout or server failure returns a non-zero exit and
keeps the mode-`0600` credential for a safe retry. Use `--json` for
machine-readable output. The stable exit codes are documented by running
`infoqast --help`.

Account-side eligibility and revocation are available in InfoQast under
**Settings → Developer access**. A workspace must separately have portal
approval, MCP preview admission and a commercial automation entitlement. The
global MCP runtime switch can pause all new and existing connections without
disabling the portal.

Remote Open Beta v1 is pinned to `https://infoqast.com/mcp`. `--server` exists only
for local development and accepts literal loopback addresses such as
`http://127.0.0.1:3000/mcp`; hostnames (including `localhost`), private network
addresses and arbitrary remote origins are rejected. Future Enterprise
self-hosted CLI support requires a separately reviewed transport that pins the
validated address through the TLS connection.

## Build and verify

Node.js 24 or newer is required.

```bash
npm ci
npm run check
```

The package verifier builds the CLI, asks npm for the exact tarball manifest,
and rejects any file outside the allowlist. Pull requests and `main` run the
same checks on a GitHub-hosted runner.

This public repository follows the [account CI policy](https://github.com/tmhwk77/tmhwk77/blob/main/CI_POLICY.md).
Standard public runners do not incur Actions execution charges. All existing
checks and the required `verify` status remain enabled; only superseded runs
of the same PR are cancelled. Main and protected release workflows retain their
complete validation and are never cancelled by this PR policy.

## Release safety

After the one-time first-package bootstrap, releases are staged from the public
repository by `.github/workflows/stage.yml` using npm trusted publishing
(OIDC), not a long-lived registry token. The workflow accepts only a release
tag whose version exactly matches `package.json`, verifies that the tagged
commit belongs to `main`, reruns the full check, and calls `npm stage publish`.
A human must inspect and approve the staged package with npm 2FA before it
becomes immutable public registry state.

npm cannot stage a brand-new package or configure its trusted publisher before
the package exists. The exact one-use GitHub provenance bootstrap, immediate
token removal, and stage-only transition are documented in
[RELEASING.md](RELEASING.md). Until the production and registry gates approve
that procedure, no release tag or workflow dispatch is allowed.

Security reports belong in [InfoQast Support](https://infoqast.com/support),
not a public issue containing credentials or customer content.
