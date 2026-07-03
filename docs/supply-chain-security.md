# Supply-chain security

This page documents the public supply-chain trust posture for
`typeorm-timescaledb`.

The project is pre-1.0, so the goal is not to claim perfect maturity. The goal is
to make package publishing, dependency review, and repository controls visible
and reviewable before broader adoption.

## Current trust model

The package should be trusted through a combination of:

- reviewed changes on `main`;
- CI checks before merge;
- malware signature scanning;
- CodeQL analysis;
- dependency review on pull requests;
- OpenSSF Scorecard visibility;
- package smoke tests for published package shape;
- npm provenance on release publishes;
- private vulnerability reporting.

No single check is enough on its own. Treat these as overlapping controls.

## OpenSSF Scorecard

The repository runs an OpenSSF Scorecard workflow on pull requests, pushes to
`main`, and a weekly schedule.

Scorecard helps track public supply-chain signals such as:

- whether the project has security policy metadata;
- whether CI is used;
- whether branch protection is visible to Scorecard;
- whether dependencies and pinned actions are used safely;
- whether risky patterns are present.

Scorecard output should be treated as an improvement signal, not a marketing
claim. A lower score is not automatically a vulnerability, and a higher score is
not a security guarantee.

## Dependency Review

The repository runs GitHub Dependency Review on pull requests targeting `main`.

Dependency Review should fail when a pull request introduces a dependency with a
high-severity advisory or worse. Reviewers should still inspect dependency
changes manually when a PR touches package manifests or lockfiles.

When Dependency Review fails:

1. Check whether the advisory affects runtime, build-time, or optional code.
2. Prefer upgrading or replacing the dependency.
3. Avoid suppressing the alert unless the risk is understood and documented.
4. Leave a PR comment explaining the decision if an exception is accepted.

## npm provenance

The release workflow publishes packages with npm provenance enabled.

For each public release, maintainers should verify that npm displays provenance
for both published packages:

- `typeorm-timescaledb`;
- `@blueprime/timescaledb-core`.

The release workflow is designed so releases come from reviewed `main` commits:

- releases are triggered by `v*` tags;
- the tag must point to a commit that is on `main`;
- package versions must match the release tag;
- packages are published with `--provenance`;
- the release workflow requests `id-token: write` for trusted publishing/OIDC.

If npm provenance is missing for a release, treat that release as needing manual
review before promoting it publicly.

## Branch protection confirmation

Branch protection is configured in repository settings, not in this directory.
Maintainers should keep `main` protected with required checks before merge.

Recommended required checks:

- Malware Gate;
- CI / lint + typecheck + unit;
- CI / package smoke;
- CI / integration matrix;
- CI / integration toolkit;
- CodeQL;
- Dependency Review;
- OpenSSF Scorecard.

Recommended review settings:

- require at least one approving review before merge;
- dismiss stale approvals when new commits are pushed;
- require conversations to be resolved before merge;
- restrict who can push directly to `main`;
- avoid force pushes to `main`.

Because branch protection lives in GitHub settings, changes to those settings
should be reviewed by maintainers and periodically confirmed outside code review.

## Package contents

The package smoke test verifies the install shape that users receive. It checks
that packed tarballs contain expected `dist` artifacts, that source files are not
published unintentionally, that ESM/CJS imports work, that the NestJS subpath is
available, and that the CLI binary is installed.

This check is separate from integration tests. Integration tests verify database
behavior; package smoke tests verify the package distribution shape.

## Security reports

Security issues should be reported privately through GitHub Private Vulnerability
Reporting. Do not open public issues for vulnerabilities.

See [Security Policy](../SECURITY.md) for reporting instructions.

## Maintainer checklist before release

Before cutting a public release, confirm:

- the release commit is on `main`;
- CI and security checks passed on the release commit;
- package smoke tests passed;
- no unexpected dependency review findings are open;
- package versions match the release tag;
- npm provenance will be emitted by the release workflow;
- the generated package contents are expected;
- release notes/changelog are accurate;
- security-sensitive changes were reviewed by a maintainer.
