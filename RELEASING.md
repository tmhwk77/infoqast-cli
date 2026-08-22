# Releasing

Package versions are immutable. Do not create a release tag or run a publish
workflow until the InfoQast production and registry gates name the exact source
commit, version, tarball checksum, release owner, and rollback owner.

## First package bootstrap

npm does not allow staged publishing for a brand-new package, and a trusted
publisher cannot be configured until that package exists. The first release is
therefore a one-time bootstrap:

1. Prove control of the `@infoqast` npm scope and enable 2FA on the owner
   account.
2. Create a same-day granular npm token with the minimum authority capable of
   creating the public `@infoqast/cli` package. Never put it in source, a local
   file, terminal output, or evidence.
3. Add it only as the `NPM_BOOTSTRAP_TOKEN` secret on the `npm-release` GitHub
   environment.
4. Create the exact `v0.1.0-beta.1` tag on a green commit already in `main`,
   then manually run `Bootstrap first npm release` with that exact tag.
5. Verify registry visibility, `beta` dist-tag, tarball checksum, clean-machine
   install, package signatures, and the GitHub provenance attestation.
6. Configure the package trusted publisher as GitHub Actions repository
   `tmhwk77/infoqast-cli`, workflow `stage.yml`, environment `npm-release`,
   allowing `npm stage publish` only.
7. Through a protected pull request, delete `bootstrap.yml`; delete the GitHub
   environment secret and revoke the npm token. Confirm both are absent.

Any failed or ambiguous registry response stops the process. Reconcile the
exact version and checksum through the registry before retrying; never bump or
republish speculatively.

## Subsequent beta versions

1. Change the version through a reviewed pull request and let `verify` pass.
2. Create the matching `v<version>` tag on that commit.
3. Manually run `Stage npm release` with the exact tag.
4. Inspect the staged package and provenance, then approve it with npm 2FA.
5. Verify the immutable registry artifact, `beta` dist-tag, signatures, clean
   macOS/Linux install, login/read/draft/logout, and expiry-to-reauthorization.

The stage workflow has no npm token. Its OIDC identity is restricted by the
trusted-publisher tuple above, and final publication still requires human 2FA.
