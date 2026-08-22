# Contributing

This repository is the public release source for the InfoQast CLI. Keep changes
small, include tests for behavior, and run:

```bash
npm ci
npm run check
```

Never add secrets, recorded OAuth credentials, customer content, private tenant
identifiers, generated `dist`, coverage output, or files outside the npm package
allowlist. Product and server changes belong in the private InfoQast application
repository; this repository contains only the standalone CLI release surface.
