# Social posts

These posts are launch drafts. Replace placeholder links before publishing.

## LinkedIn launch post

We have been working on `typeorm-timescaledb`: a TypeORM-first integration for
TimescaleDB.

The goal is to help TypeScript teams keep their TypeORM workflow while adopting
supported TimescaleDB capabilities through reviewable migrations and typed
helpers.

Current focus:

- hypertable metadata through decorators;
- reviewable TimescaleDB migration generation;
- retention and columnstore policy setup;
- NestJS integration;
- typed query helpers for common time-series workflows;
- production guidance and troubleshooting docs;
- package smoke tests and supply-chain trust signals.

The package is pre-1.0, so the docs are clear about supported scope and when
manual migrations are required.

Start with the quickstart or the 10-minute tutorial: [LINK]

Feedback is welcome, especially from TypeORM, NestJS, and TimescaleDB users.

## X / Twitter post

We built `typeorm-timescaledb`: a TypeORM-first TimescaleDB integration for
TypeScript apps.

It adds supported TimescaleDB workflows through reviewable migrations, NestJS
support, and typed query helpers, without globally mutating TypeORM.

Pre-1.0 and looking for feedback: [LINK]

## Dev.to / Hashnode intro

If you use TypeORM and want to model time-series data in TimescaleDB, we are
preparing `typeorm-timescaledb` for broader feedback.

It keeps a clear boundary:

- TypeORM creates the base table.
- The package adds the supported TimescaleDB layer.
- Generated migrations are reviewable.
- Production config changes stay explicit.

Start here: [LINK]

## Reddit / community post

Title idea: TypeORM + TimescaleDB integration with reviewable migrations

Post:

We are preparing a TypeScript package called `typeorm-timescaledb` for broader
feedback.

It is meant for teams that already use TypeORM and want a cleaner path to
supported TimescaleDB workflows: hypertable metadata, migration generation,
retention/columnstore policy setup, NestJS support, and time-series query
helpers.

It is pre-1.0, and the docs are intentionally conservative about what is and is
not supported. The package does not claim full TimescaleDB coverage or automatic
live config reconciliation.

I would appreciate feedback from TypeORM, NestJS, and TimescaleDB users:

- Does the migration model make sense?
- Are the docs clear enough?
- What workflows should be supported next?

Repo/docs: [LINK]

## Internal BluePrime announcement

`typeorm-timescaledb` is moving into launch-preparation mode.

Recent work completed:

- documentation structure;
- quickstart and tutorial;
- Docker Compose local setup;
- runnable example;
- API reference;
- production guide;
- troubleshooting guide;
- package smoke tests;
- supply-chain trust docs and workflows;
- launch content drafts.

Next focus: review launch content, confirm approved public claims, prepare demo
assets, and decide where/when to share externally.

## Maintainer call for feedback

We are looking for feedback on `typeorm-timescaledb`, a pre-1.0 TypeORM
integration for TimescaleDB.

The main design choice: TimescaleDB changes should be reviewable migrations, not
hidden runtime side effects.

Useful feedback areas:

- TypeORM migration workflow fit;
- NestJS module ergonomics;
- query-helper API design;
- production safety language;
- missing TimescaleDB workflows;
- unclear docs or examples.

Links: [LINK]

## Short product description

`typeorm-timescaledb` is a TypeORM-first TimescaleDB integration for TypeScript
apps. It supports typed hypertable metadata, reviewable migration generation,
NestJS integration, schema sanity checks, and typed helpers for common time-series
query patterns.

## One-line description

TypeORM-first TimescaleDB workflows with reviewable migrations, NestJS support,
and typed query helpers.

## Hashtag ideas

- #TypeScript
- #PostgreSQL
- #TimescaleDB
- #TypeORM
- #NestJS
- #OpenSource
- #TimeSeries
