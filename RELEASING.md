# Releasing

Releases are cut by **pushing a version tag**. The [`release`](.github/workflows/release.yml)
workflow then publishes both packages to npm.

## One-time setup (npmjs.com)

1. Create/confirm the **`@blueprime`** npm org (owns `@blueprime/timescaledb-core`).
2. Pick an auth method for the `release` workflow:
   - **Automation token (recommended — reliable today):** create a granular npm automation
     token scoped to both packages and add it as the repo secret **`NPM_TOKEN`**. The
     workflow still emits npm **provenance** via `id-token: write`.
   - **Trusted Publishing (tokenless OIDC):** add a trusted publisher for **both** packages
     → GitHub Actions, repo `BluePrime-Technologies/typeorm-timescaledb`, workflow
     `release.yml`, and leave `NPM_TOKEN` unset. Requires a pnpm version that supports
     tokenless OIDC publishing; if a release fails to authenticate, use the token method.

Both package names (`typeorm-timescaledb`, `@blueprime/timescaledb-core`) are currently unclaimed.

## Public claims gate

Before publishing a release, updating npm-facing documentation, or preparing public
release notes, run the [public claims checklist](docs/public-claims-checklist.md).
Use [feature status](docs/feature-status.md) as the source of truth
for what is shipped, planned, experimental, or unsupported.

Do not publish release copy that presents planned features as shipped functionality.

## Cutting a release

1. Bump the version in **both** `packages/core/package.json` and `packages/typeorm/package.json`
   to the same value (they release in lockstep), open a PR, and merge it once CI is green.
2. From an up-to-date `main`:
   ```sh
   git tag v0.1.0        # must equal the package version
   git push origin v0.1.0
   ```
3. The `release` workflow builds, runs the unit gate, verifies the tag matches the package
   versions, then `pnpm publish`es **core first**, then **typeorm-timescaledb** (with provenance).
   `pnpm publish` rewrites the `workspace:*` core dependency to the concrete version.

## If a release half-publishes

Publishing is sequential (core, then typeorm-timescaledb) and **idempotent** — each step
skips a version already on npm. So if core publishes but typeorm-timescaledb fails (e.g. a
transient npm outage), just **re-run the `release` workflow on the same tag**: it skips the
already-published core and publishes the rest.

## Scoped-package "published but 404" (first publish under a new org)

A scoped package's **first** publish under a freshly created npm org can report success
(`+ @blueprime/...`, "public access") yet still return **404** to anonymous `npm view` /
`npm install` until access is re-asserted. The `release` workflow now defends against this by
running `npm access set status=public @blueprime/timescaledb-core` after the core publish
(idempotent; skipped under tokenless OIDC since there's no token for the access call). If you
ever hit it manually, the fix is the same one-liner, authenticated as the publishing account.

## Notes

- The published `typeorm-timescaledb` README is the repo root `README.md` (copied in via the
  package `prepack` step); `@blueprime/timescaledb-core` ships its own README.
- Pre-publish quality is already validated on every PR (lint, typecheck, unit, the integration
  matrix on TimescaleDB 2.18 + latest, `publint`, `attw`). The release workflow assumes the
  tagged commit passed CI.
