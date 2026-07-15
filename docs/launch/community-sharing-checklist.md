# Community sharing checklist

Use this checklist before sharing `typeorm-timescaledb` publicly.

## Before posting

- Confirm the latest release version is published and installable.
- Confirm README, docs index, quickstart, tutorial, production guide, and
  troubleshooting guide are up to date.
- Confirm package smoke tests pass.
- Confirm supply-chain trust docs are current.
- Confirm npm provenance visibility for the latest release.
- Confirm branch protection and required checks are configured in GitHub.
- Confirm no launch asset contains unapproved claims.
- Replace every `[LINK]` placeholder in launch assets.
- Decide whether to point users to the repository, docs site, npm package, or all
  three.

## Approved message

Use this message as the center of launch communication:

`typeorm-timescaledb` brings TimescaleDB workflows into TypeORM with reviewable
migrations, NestJS support, typed query helpers, and a production-minded safety
model, without globally mutating TypeORM.

## Claims to avoid

Do not claim:

- full TimescaleDB feature coverage;
- complete production maturity;
- complete live schema auto-diffing;
- automatic destructive migrations;
- guaranteed performance improvements;
- compliance or enterprise readiness unless approved;
- official Timescale endorsement unless explicitly granted.

## Places to share

Candidate channels:

- BluePrime website or blog;
- BluePrime LinkedIn;
- maintainer LinkedIn;
- X / Twitter;
- Dev.to or Hashnode;
- relevant TypeScript communities;
- relevant PostgreSQL communities;
- relevant NestJS communities;
- relevant TypeORM communities;
- internal BluePrime channels.

Before posting to any third-party community, read the community rules and avoid
spammy self-promotion. Lead with the problem, the design choices, and a request
for feedback.

## Links to include

Choose links based on the audience:

- GitHub repository;
- npm package;
- docs index;
- installation guide;
- quickstart;
- 10-minute tutorial;
- Docker Compose setup;
- runnable quickstart example;
- production guide;
- troubleshooting guide;
- migration safety article;
- NestJS tutorial.

## Demo assets

Prepare:

- one short terminal demo;
- one entity screenshot or code snippet;
- one migration-generation screenshot;
- one docs screenshot;
- one architecture/safety diagram if available;
- one 30-second summary clip if possible.

## Feedback routing

Before launch, decide:

- who watches GitHub issues;
- who responds to social comments;
- which issues are bugs vs feature requests vs docs gaps;
- what label names should be used;
- what response time is realistic;
- when to move feedback into roadmap planning.

## Suggested issue labels

- `bug`
- `docs`
- `example`
- `question`
- `enhancement`
- `timescaledb`
- `nestjs`
- `migration`
- `query-layer`
- `good first issue`

## Launch-day checklist

- Publish the launch blog post.
- Share LinkedIn post.
- Share short X / Twitter post.
- Share Dev.to or Hashnode version if approved.
- Share in selected communities according to their rules.
- Pin or highlight the quickstart link.
- Watch issues and comments for the first day.
- Collect repeated questions into troubleshooting docs.
- Log missing workflows as issues or roadmap candidates.

## Post-launch follow-up

Within one week:

- review issues opened from launch;
- identify confusing docs sections;
- update troubleshooting if repeated questions appear;
- prioritize real-world examples requested by users;
- record adoption signals;
- decide whether a public docs site should be the next launch-support milestone.
