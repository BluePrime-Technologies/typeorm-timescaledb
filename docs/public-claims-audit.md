# Public claims audit for 0.1.x

Related issue: #33

## Purpose

This audit freezes the public claims currently made for `typeorm-timescaledb`
and checks them against shipped 0.1.x evidence from implementation, tests,
package metadata, CI, release workflow, and public repository files.

The outcome is intentionally narrow: this file does not add new feature claims
or implement new functionality. It records which claims are supported today,
which claims are true only within the current 0.1.x scope, and which wording
should remain constrained until later releases ship more capabilities.

## Public surfaces reviewed

- `README.md`
- `packages/typeorm/package.json`
- `packages/core/package.json`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `RELEASING.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/ISSUE_TEMPLATE/bug.yml`
- TypeORM package source and integration tests
- Core package identifier-safety source
- Shipped code comments / JSDoc (published in `.d.ts`)

## Summary

Most current public claims are supported for the 0.1.x foundation scope.
The strongest evidence comes from:

- README scope statements and examples.
- Package metadata for exports, types, engines, peer dependencies, and publish
  configuration.
- CI coverage across Node, TypeORM, and TimescaleDB versions.
- Deep integration tests against a real TimescaleDB container.
- Source-level exports for decorators, migration generation, `createTimescale`,
  and `assertSchema`.
- Core identifier-safety helpers and the security policy.

The key wording constraint is that claims should continue to say 0.1.x delivers
hypertables, columnstore, retention, space/hash partitioning, migration
utilities, repositories, drift checks, and NestJS wiring. Claims should not
imply shipped support for continuous aggregates, hyperfunction query
expressions, a full entity-to-database diff engine, or validated cross-store
references.

## Claim-by-claim audit

### Multi-DataSource-safe

Status: supported.

Evidence:

- `README.md` states the integration is multi-DataSource-safe and scopes all
  behavior to the supplied `DataSource`.
- `packages/typeorm/src/index.ts` documents the no-global-mutation design and
  module-private metadata model.
- `CONTRIBUTING.md` makes no global mutation a project rule and requires the
  two-DataSource isolation test to remain green.

Recommended wording:

- Keep the claim, but continue to tie it to the package's own TimescaleDB
  metadata/runtime and per-DataSource APIs.

### No global mutation

Status: supported.

Evidence:

- `README.md` explicitly states that no globals are patched.
- `packages/typeorm/src/index.ts` states decorators write to a module-private
  `WeakMap`, never prototypes or TypeORM global metadata.
- `CONTRIBUTING.md` forbids patching `DataSource.prototype`,
  `Repository.prototype`, or shared globals.

Recommended wording:

- Keep the claim.

### TypeORM-native integration

Status: supported within 0.1.x scope.

Evidence:

- `README.md` shows users defining TypeORM entities with a unified import
  surface.
- `packages/typeorm/src/index.ts` re-exports the TypeORM modeling surface and
  TimescaleDB decorators from one package.
- `packages/typeorm/package.json` declares TypeORM as a peer dependency.

Recommended wording:

- Keep `TypeORM-native integration` or `TypeORM-first integration`.
- Avoid implying that every TimescaleDB feature is represented yet.

### Typed hypertables and decorators

Status: supported.

Covered claims:

- Typed hypertables.
- `@Hypertable`.
- `@TimeColumn`.
- `@HypertablePrimaryKey`.

Evidence:

- `README.md` demonstrates these decorators in the quick-start entity.
- `packages/typeorm/src/index.ts` exports the decorators.
- `packages/typeorm/test/e2e.integration.test.ts` uses the decorators in real
  integration entities.

Recommended wording:

- Keep the claim.

### Columnstore support

Status: supported for 0.1.x DDL and policy scope.

Evidence:

- `README.md` documents columnstore options in the quick start and 0.1.0 scope.
- `packages/typeorm/test/e2e.integration.test.ts` verifies columnstore settings,
  compression policy creation, compressed chunks, and columnstore-without-policy
  behavior against TimescaleDB catalogs.

Recommended wording:

- Keep the claim as `columnstore support`.
- Avoid implying coverage of every possible TimescaleDB compression/columnstore
  setting beyond the documented options.

### Retention policy support

Status: supported.

Evidence:

- `README.md` documents retention options in the quick start and 0.1.0 scope.
- `packages/typeorm/test/e2e.integration.test.ts` verifies retention policy
  jobs and retention behavior against a live TimescaleDB database.

Recommended wording:

- Keep the claim.

### Space/hash partitioning support

Status: supported.

Evidence:

- `README.md` lists space/hash partitioning in the shipped 0.1.0 scope.
- `packages/typeorm/test/e2e.integration.test.ts` verifies that `by_hash` adds
  a second TimescaleDB dimension.

Recommended wording:

- Keep the claim.

### Migration generation

Status: supported.

Evidence:

- `README.md` documents migration generation and CLI usage.
- `packages/typeorm/src/index.ts` exports migration-generation APIs.
- `packages/typeorm/test/e2e.integration.test.ts` generates and applies
  migrations against a real TimescaleDB container.

Recommended wording:

- Keep the claim.
- Continue to clarify that the package adds the TimescaleDB layer on top of the
  base TypeORM table.

### CLI commands: generate, run, revert, status

Status: supported as a public package surface.

Evidence:

- `README.md` documents `generate`, `run`, `revert`, and `status`.
- `packages/typeorm/package.json` exposes the `typeorm-timescaledb` binary.

Recommended wording:

- Keep the command list.

### Non-destructive generated `down()` behavior

Status: supported.

Evidence:

- `README.md` states generated `down()` behavior is never destructive.
- `CONTRIBUTING.md` makes non-destructive rollbacks a ground rule.
- `packages/typeorm/test/e2e.integration.test.ts` verifies policy removal while
  preserving hypertables and data.

Recommended wording:

- Keep the claim.
- Continue to distinguish non-destructive generated rollback from future full
  diff behavior.

### Per-DataSource repositories through `createTimescale`

Status: supported.

Evidence:

- `README.md` documents `createTimescale(dataSource)` and typed repository
  access.
- `packages/typeorm/src/index.ts` exports `createTimescale`.
- `packages/typeorm/test/e2e.integration.test.ts` saves and reads through the
  Timescale-aware repository.

Recommended wording:

- Keep the claim.

### Schema drift detection through `assertSchema`

Status: supported.

Evidence:

- `README.md` documents `assertSchema` as a drift check.
- `packages/typeorm/src/index.ts` exports `assertSchema`.
- `packages/typeorm/test/e2e.integration.test.ts` verifies an in-sync result and
  a drift failure after a policy is removed.

Recommended wording:

- Keep the claim.
- Keep the scope narrow to TimescaleDB metadata covered by 0.1.x.

### NestJS module support

Status: supported as optional integration wiring.

Evidence:

- `README.md` includes NestJS module examples and named multi-DataSource
  contexts.
- `packages/typeorm/package.json` exports `./nestjs` for ESM and CJS and marks
  Nest packages as optional peers.

Recommended wording:

- Keep `NestJS module support`.
- Prefer `optional NestJS module support` when space allows.

### Dual ESM and CJS support

Status: supported.

Evidence:

- `README.md` says the package ships dual ESM and CJS.
- `packages/typeorm/package.json` and `packages/core/package.json` expose import
  and require entrypoints and include CJS main fields.

Recommended wording:

- Keep the claim.

### Full type declarations

Status: supported.

Evidence:

- `README.md` says the package ships full type definitions.
- `packages/typeorm/package.json` and `packages/core/package.json` publish type
  declaration entrypoints.

Recommended wording:

- Keep the claim.

### TimescaleDB >= 2.18 support

Status: supported.

Evidence:

- `README.md` states TimescaleDB >= 2.18 is required.
- `.github/workflows/ci.yml` runs the integration matrix against
  `2.18.0-pg16` and `latest-pg17`.
- The workflow comments explain that 2.18 is the floor for the columnstore DDL
  emitted by the package.

Recommended wording:

- Keep the claim.

### TypeORM `^0.3.20 || ^1.0.0` support

Status: supported.

Evidence:

- `README.md` states the supported peer range.
- `packages/typeorm/package.json` declares the same TypeORM peer dependency.
- `.github/workflows/ci.yml` runs the integration matrix against TypeORM
  `0.3.20` and `1.0.0`.

Recommended wording:

- Keep the claim.

### Node `>=20.19 || >=22.12` support

Status: mostly supported; wording should mirror package metadata exactly.

Evidence:

- `README.md` states Node `>=20.19 || >=22.12`.
- `packages/typeorm/package.json` and `packages/core/package.json` use the
  engine range `^20.19.0 || >=22.12.0`.
- `.github/workflows/ci.yml` runs integration jobs on Node 20, 22, and 24.

Recommended wording:

- Prefer the exact package metadata form when space allows:
  `Node ^20.19.0 || >=22.12.0`.
- The README's existing wording is directionally correct, but exact metadata
  wording avoids ambiguity about Node 21.

### Real TimescaleDB integration/E2E coverage

Status: supported.

Evidence:

- `README.md` claims the package is verified end-to-end against real
  TimescaleDB.
- `.github/workflows/ci.yml` runs a TimescaleDB integration matrix.
- `packages/typeorm/test/e2e.integration.test.ts` starts a real TimescaleDB
  container, applies generated migrations, verifies catalog state, inserts real
  data, compresses chunks, drops chunks, and tests repositories and drift.

Recommended wording:

- Keep the claim.

### Identifier safety and SQL injection boundary claims

Status: supported for dynamic identifiers handled by the core helpers.

Evidence:

- `packages/core/package.json` describes identifier safety as part of the core
  package.
- `packages/core/src/identifier.ts` implements conservative identifier
  validation, quoting, qualified quoting, and safe-by-default `safeIdent`.
- `SECURITY.md` explains that dynamic table/column identifiers should be
  allow-listed and quoted, and that values are bound parameters.

Recommended wording:

- Keep the claim, but keep it precise: dynamic identifiers accepted by package
  APIs are validated and quoted; values are bound parameters.
- Avoid wording that implies the library can make arbitrary user-written raw SQL
  safe.

### npm provenance and release workflow claims

Status: supported as workflow capability.

Evidence:

- `.github/workflows/release.yml` grants `id-token: write` for npm provenance
  and publishes with `--provenance`.
- `RELEASING.md` documents npm provenance, trusted publishing, tag validation,
  sequential package publishing, and idempotent re-runs.

Recommended wording:

- Keep the claim as a release workflow capability.
- Avoid implying every historical publish necessarily used provenance unless
  verifying the specific npm package version.

### Issue templates

Status: partially supported on `main`.

Evidence:

- `.github/ISSUE_TEMPLATE/bug.yml` provides a bug report form.

Recommended wording:

- Public docs should not yet claim a full issue-template suite on `main` unless
  the general/non-bug issue form PR has landed.
- It is safe to say the repository has a bug report template.

### Code comments / JSDoc shipped in `.d.ts`

Status: supported; no overclaim found.

Evidence:

- `packages/typeorm/src/index.ts`, `packages/typeorm/src/runtime/createTimescale.ts`,
  and `packages/typeorm/src/runtime/assertSchema.ts` doc-comments describe the
  no-global-mutation and per-DataSource isolation design; these match the audited
  README claims and are enforced by the two-DataSource isolation integration test.
- `packages/core/src/identifier.ts` doc-comments scope safety to dynamic
  identifiers (validate then quote); they do not imply the library can make
  arbitrary user-written raw SQL safe.
- These comments ship in the published `.d.ts` files and appear on consumer IDE
  hover, so they are audited here as a public-claims surface in their own right.

Recommended wording:

- Keep JSDoc claims tied to the same evidence as the README.
- Treat any future `guarantee`, `automatic`, or `fully` language in shipped
  comments as a public claim that requires the same evidence link.

## Claims that should stay explicitly out of 0.1.x

The README correctly lists the following as not yet shipped or planned:

- Continuous aggregates.
- Hyperfunction query expressions.
- Full entity-to-database diff engine.
- Validated cross-store references.

These should not appear in npm copy, README summaries, release notes, or issue
templates as shipped features until they are implemented, tested, and released.

## Unsupported or overstated claims found

No clearly unsupported shipped-feature claim was found in the reviewed public
surfaces.

The only wording adjustment recommended by this audit is to align Node support
wording with package metadata where exactness matters:

- Current README wording: `Node >=20.19 || >=22.12`.
- Exact package metadata: `Node ^20.19.0 || >=22.12.0`.

This is a precision adjustment, not a functional contradiction.

## Follow-up issues recommended

No feature claim in the reviewed public surfaces requires immediate follow-up
engineering work before it can remain public for 0.1.x.

Recommended non-blocking follow-ups:

- Add or merge a general/non-bug issue form before claiming a full issue-intake
  suite beyond bug reports.
- Consider normalizing Node support wording in README and package-facing copy to
  match `package.json` exactly.
- When changelog or release notes are added, require each new public claim to
  link back to implementation, tests, metadata, CI, or release workflow evidence.

## Acceptance criteria check

- Each public claim is mapped to source evidence.
- Unsupported or overstated claims are listed with recommended wording changes.
- Claims true only within current 0.1.x scope are marked as such.
- No immediate engineering test-coverage gap was found for the reviewed shipped
  claims.
- This file is the committed audit artifact for issue #33.
