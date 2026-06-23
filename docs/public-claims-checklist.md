# Public claims checklist

Use this checklist before publishing a release, updating npm-facing package
metadata, changing README copy, writing release notes, or preparing public
awareness material.

The goal is simple: public copy must describe what the current release actually
ships, not what is planned or internally assumed.

## 1. Classify every public claim

For each claim, mark exactly one status:

- [ ] **Shipped**: implemented and supported by source, tests, metadata, CI, or
      release workflow evidence.
- [ ] **Planned**: intended, but not shipped in the current release.
- [ ] **Experimental**: available in limited form and clearly described as such.
- [ ] **Unsupported**: not available and should not appear as a shipped claim.

If a claim cannot be classified, do not publish it.

## 2. Verify README wording

- [ ] The README separates shipped features from planned features.
- [ ] README examples only use shipped APIs.
- [ ] README install instructions match package metadata.
- [ ] README platform support matches package metadata exactly.
- [ ] README migration-safety language matches actual migration behavior.
- [ ] README security claims match the security policy and implementation.

## 3. Verify npm package metadata

Check `packages/typeorm/package.json` and `packages/core/package.json`.

- [ ] Package descriptions do not overstate shipped functionality.
- [ ] Keywords are accurate for shipped package scope.
- [ ] `exports`, `main`, `module`, and `types` match the built package shape.
- [ ] Node engine ranges are accurate.
- [ ] TypeORM peer dependency ranges are accurate.
- [ ] NestJS peer dependency ranges are accurate when NestJS support is
      mentioned.
- [ ] Package repository, homepage, and bugs links are correct.

## 4. Verify shipped versus planned features

Compare public wording with `docs/feature-status-0.1.x.md`.

- [ ] Shipped features are listed as shipped only if implementation and tests
      support them.
- [ ] Planned features are clearly marked as planned or not yet shipped.
- [ ] Unsupported features are not implied by examples, release notes, or npm
      copy.
- [ ] Current limitations are easy to find from the README or linked docs.

## 5. Verify platform support claims

- [ ] Node support matches package metadata.
- [ ] TypeORM support matches package metadata and CI matrix coverage.
- [ ] TimescaleDB support matches README and CI matrix coverage.
- [ ] NestJS support, if mentioned, matches optional peer metadata.
- [ ] Claims about ESM, CJS, and TypeScript declarations match package exports.

## 6. Verify migration safety claims

- [ ] Generated migrations are described as reviewable and non-destructive for
      generated `down()` behavior.
- [ ] Public copy does not imply a full entity-to-database diff engine exists.
- [ ] Public copy does not imply automatic destructive or altering migrations.
- [ ] Manual migration requirements are stated where relevant.

## 7. Verify security claims

- [ ] Vulnerability reporting instructions match `SECURITY.md`.
- [ ] Public issue templates tell users not to report security issues publicly.
- [ ] Identifier-safety claims are limited to package-managed dynamic
      identifiers.
- [ ] Public copy does not imply arbitrary raw SQL written by users becomes safe.

## 8. Verify test coverage claims

- [ ] Claims about real TimescaleDB coverage match CI and integration tests.
- [ ] Claims about TypeORM version support match CI matrix coverage.
- [ ] Claims about Node version support match CI matrix coverage.
- [ ] Claims about release readiness match the actual workflow gates.

## 9. Verify release workflow and provenance claims

- [ ] Release workflow claims match `.github/workflows/release.yml`.
- [ ] npm provenance wording is accurate for the current workflow.
- [ ] Package publish order is described correctly.
- [ ] Release notes do not claim a package was published with a guarantee that
      cannot be verified for that specific version.

## 10. Verify changelog and release notes

- [ ] Changelog entries only describe merged changes.
- [ ] Release notes distinguish shipped features, fixes, docs, tests, and
      chores.
- [ ] Release notes call out limitations and breaking changes when relevant.
- [ ] Release notes do not promote planned features as shipped.

## 11. Smoke-test public examples

- [ ] README code examples use exported package APIs.
- [ ] CLI examples use the documented binary name.
- [ ] TypeScript examples compile or are intentionally illustrative.
- [ ] Examples do not rely on internal-only files or private context.

## Final gate

Before publishing or merging public-facing copy, answer these questions:

1. Can every shipped claim be mapped to evidence?
2. Are planned features clearly marked as planned?
3. Are unsupported features absent from shipped-feature copy?
4. Are package metadata and README wording aligned?
5. Would a new user understand what 0.1.x does and does not do?

If any answer is no, update the wording before release.
