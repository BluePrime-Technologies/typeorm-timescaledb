# Community sharing checklist

Use this checklist before posting launch content publicly.

## 1. Confirm readiness

Before sharing externally, confirm:

- README is accurate.
- Installation guide is current.
- Quickstart works.
- Tutorial works.
- Docker Compose local setup works.
- Runnable quickstart example works.
- API reference is current for the active release line.
- Production guide is linked.
- Troubleshooting guide is linked.
- Supply-chain trust guide is linked if merged.
- Package smoke tests are passing.
- CI, CodeQL, Malware Gate, and required trust checks are passing.
- npm package versions match the release tag.
- npm provenance or trusted-publishing metadata is visible where expected.

## 2. Confirm launch links

Prepare final URLs for:

- GitHub repository;
- npm package: `typeorm-timescaledb`;
- npm package: `@blueprime/timescaledb-core`;
- documentation index;
- quickstart;
- tutorial;
- Docker Compose setup;
- runnable quickstart example;
- production guide;
- troubleshooting guide;
- NestJS guide;
- changelog;
- issue tracker.

Do not post until the links resolve publicly.

## 3. Prepare screenshots or clips

Useful visuals:

- entity with `@Hypertable()` and `@TimeColumn()`;
- generated migration file;
- terminal showing migration generation;
- terminal showing migration run;
- TimescaleDB hypertable verification query;
- NestJS module registration;
- query-layer example;
- package smoke test or CI status.

Avoid screenshots that show secrets, private URLs, credentials, tokens, internal
customer names, private infrastructure, or unreleased product plans.

## 4. Choose channels

Recommended channels:

- BluePrime blog or website;
- LinkedIn company page;
- maintainer personal LinkedIn posts;
- X / Bluesky short announcement;
- Dev.to article;
- relevant TypeScript / TypeORM / PostgreSQL / TimescaleDB communities;
- internal BluePrime engineering announcement.

Only post in communities where project announcements are allowed. Prefer helpful
technical framing over promotion.

## 5. Match content to audience

For TypeORM users, emphasize:

- TypeORM-first workflow;
- base table ownership;
- generated migrations;
- familiar DataSource usage.

For TimescaleDB users, emphasize:

- hypertable metadata;
- retention and columnstore setup;
- query helpers;
- production safety boundaries.

For NestJS users, emphasize:

- module registration;
- repository injection;
- named DataSource contexts;
- no global TypeORM mutation.

For security-conscious teams, emphasize:

- reviewable migrations;
- package smoke tests;
- supply-chain trust checks;
- conservative non-destructive rollback model.

## 6. Avoid overpromising

Do not claim:

- complete TimescaleDB coverage;
- full auto-diffing of every live configuration change;
- safe automatic destructive rollback;
- production readiness for every workload;
- compatibility outside the documented version range;
- exact release dates for future scope.

Use honest language:

- pre-1.0;
- supported workflows;
- reviewable migrations;
- production-minded;
- manual migrations for unsupported or high-risk changes;
- feedback welcome.

## 7. Suggested launch order

1. Publish or merge final docs.
2. Confirm npm package and provenance visibility.
3. Confirm CI and smoke tests.
4. Publish the launch blog post.
5. Share the TypeORM + TimescaleDB tutorial.
6. Share the NestJS tutorial.
7. Post short social announcements linking back to docs.
8. Share in selected communities with context-specific wording.
9. Monitor feedback for at least the first few days.
10. Convert repeated questions into docs or issues.

## 8. Feedback handling

When feedback arrives:

- thank the person;
- ask for reproduction details if needed;
- link existing docs if the answer already exists;
- open an issue for bugs or missing docs;
- avoid defensive replies;
- avoid committing to timelines in public comments;
- capture repeated friction points in the troubleshooting guide.

## 9. Issue triage labels

Suggested labels to use or create:

- `bug`
- `docs`
- `question`
- `example`
- `enhancement`
- `timescaledb`
- `typeorm`
- `nestjs`
- `migration-safety`
- `query-layer`

## 10. Post-launch follow-up

After launch:

- collect common questions;
- update troubleshooting docs;
- add missing examples;
- review install friction;
- review package smoke test coverage;
- review npm download and issue activity;
- summarize feedback for the next roadmap step.

The launch is successful if developers can understand the package, install it,
run a local example, and give useful feedback without needing private BluePrime
context.
