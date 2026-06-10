# Releasing

Releases are cut by **pushing a version tag**. The [`release`](.github/workflows/release.yml)
workflow then publishes both packages to npm.

## One-time setup (npmjs.com)

1. Create/confirm the **`@blueprime-technologies`** npm org (owns `@blueprime-technologies/timescaledb-core`).
2. Pick an auth method for the `release` workflow:
   - **Trusted Publishing (OIDC, recommended — no stored token):** in npm, add a trusted
     publisher for **both** packages → GitHub Actions, repo `BluePrime-Technologies/typeorm-timescaledb`,
     workflow `release.yml`. The workflow already requests `id-token: write`.
   - **Automation token (alternative):** create a granular npm automation token scoped to
     both packages and add it as the repo secret **`NPM_TOKEN`**.

Both package names (`typeorm-timescaledb`, `@blueprime-technologies/timescaledb-core`) are currently unclaimed.

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

## Notes

- The published `typeorm-timescaledb` README is the repo root `README.md` (copied in via the
  package `prepack` step); `@blueprime-technologies/timescaledb-core` ships its own README.
- Pre-publish quality is already validated on every PR (lint, typecheck, unit, the integration
  matrix on TimescaleDB 2.18 + latest, `publint`, `attw`). The release workflow assumes the
  tagged commit passed CI.
