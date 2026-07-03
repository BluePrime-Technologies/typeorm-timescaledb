# Supply-chain trust

This page documents the repository-level trust signals for `typeorm-timescaledb`.
It is intended for maintainers and reviewers who need to understand how the
project reduces package-publishing and dependency risk.

The project is still pre-1.0, so this page should describe the current controls
honestly. Do not treat it as a claim of complete supply-chain maturity.

## Current automated controls

### Malware Gate

The Malware Gate workflow runs on pull requests and pushes. It scans the working
tree with `scripts/malware-guard.sh` before normal CI work should be trusted.

Maintainers should keep this workflow required in branch protection.

### Dependency Review

The Dependency Review workflow runs on pull requests and checks dependency
changes for known vulnerable packages. It is configured to fail on high-severity
findings.

This helps reviewers catch risky dependency changes before merge, especially when
`package.json` or lockfile changes are introduced.

### OpenSSF Scorecard

The OpenSSF Scorecard workflow runs on a weekly schedule, on pushes to `main`,
when branch-protection rules change, and manually through `workflow_dispatch`.

The workflow uploads SARIF results so findings can be viewed through GitHub code
scanning. Scorecard results are a signal for maintainers; they are not a promise
that the package has no security risk.

### CodeQL

CodeQL runs as part of the existing repository security posture. Treat it as a
static analysis signal, not as a replacement for review, tests, or responsible
vulnerability reporting.

### Package smoke tests

Package smoke tests verify the installed package shape by packing the published
packages, installing them into a clean temporary project, and checking ESM, CJS,
subpath exports, and the CLI binary.

This reduces the chance that source tests pass while the installable npm package
is broken.

## npm provenance visibility

The release workflow publishes packages with `--provenance`, and the workflow has
`id-token: write` permission for npm provenance and OIDC trusted publishing.

After each release, maintainers should confirm provenance is visible on npm for:

- `typeorm-timescaledb`
- `@blueprime/timescaledb-core`

Release verification checklist:

1. Open the npm package page for the published version.
2. Confirm the version is public and installable.
3. Confirm provenance or trusted-publishing metadata is visible for the version.
4. Confirm the package contents are expected.
5. Run or review the package smoke test result for the release commit.
6. Confirm the GitHub release tag matches the package versions.

If provenance is missing, do not silently ignore it. Check whether the release was
published from the expected GitHub Actions workflow, whether OIDC/trusted
publishing was available, and whether fallback token publishing changed the
metadata shown by npm.

## Branch-protection confirmation

Some supply-chain controls cannot be fully proven from repository files. They
must be confirmed in GitHub repository settings.

Maintainers should configure branch protection or rulesets for `main` so that:

- pull requests are required before merging;
- required status checks include CI, Malware Gate, CodeQL, Dependency Review, and
  any required package-smoke status exposed by CI;
- stale approvals are dismissed when relevant code changes are pushed;
- force pushes to `main` are blocked;
- branch deletion is blocked;
- administrator bypass is limited and auditable;
- release tags are created from reviewed `main` commits only.

Because branch-protection settings live outside the repository contents, reviewers
should periodically confirm them in GitHub settings and record any exceptions in
release or maintenance notes.

## Maintainer release checklist

Before publishing a release, confirm:

- the release PR has passed CI, Malware Gate, CodeQL, Dependency Review, and
  package smoke tests;
- the release tag points at a reviewed commit on `main`;
- the tag matches both package versions;
- the release workflow uses provenance-enabled publish commands;
- no long-lived npm token is required when trusted publishing is available;
- published packages are public and installable from a clean project;
- provenance visibility is checked after publish;
- changelog entries match the released scope.

## What this page does not claim

This page does not claim that the package is immune to supply-chain attacks. It
only documents the current trust controls and maintainer checks.

Future improvements may include an OpenSSF Best Practices badge target, stronger
action pinning across all workflows, signed release attestations, and broader
repository ruleset documentation.
