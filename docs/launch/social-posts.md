# Social posts

Use these as launch drafts. Adjust links, screenshots, and exact version numbers
before posting.

## Positioning notes

Keep launch posts honest:

- This is a pre-1.0 package.
- It is for TypeORM projects that want TimescaleDB workflows.
- It generates reviewable migrations.
- It avoids global TypeORM mutation.
- It supports NestJS and multiple DataSources.
- It does not promise complete TimescaleDB coverage or automatic diffing for every
  live config change.

## LinkedIn launch post

We built `typeorm-timescaledb` to make TimescaleDB easier to use from TypeORM
projects.

The package helps TypeORM teams model time-series tables, generate reviewable
TimescaleDB migrations, use scoped DataSource-safe runtime helpers, and integrate
with NestJS without globally mutating TypeORM.

The current package focuses on:

- hypertable metadata;
- retention and columnstore setup;
- reviewable migrations;
- schema sanity checks with `assertSchema()`;
- NestJS integration;
- typed query helpers for common TimescaleDB workflows.

It is pre-1.0, so we are keeping the scope honest: not every TimescaleDB feature
is covered, and production config changes still need review and sometimes manual
migrations.

If you use TypeORM with PostgreSQL and want a safer path into TimescaleDB, we
would love feedback.

Start with the quickstart and runnable example.

## Short X / Bluesky post

`typeorm-timescaledb` brings TimescaleDB workflows into TypeORM:

- hypertable metadata
- reviewable migrations
- retention + columnstore setup
- NestJS support
- typed query helpers
- no global TypeORM mutation

Pre-1.0 and looking for feedback from TypeORM + TimescaleDB users.

## Developer community post

If you have ever tried to use TimescaleDB from a TypeORM app, you know the gap:
TypeORM models tables and migrations, while TimescaleDB adds hypertables,
retention policies, columnstore settings, and time-series query functions.

`typeorm-timescaledb` is an attempt to bridge that gap without hiding the database
from the developer.

The package keeps TypeORM responsible for the base table, then generates
reviewable migrations for the supported TimescaleDB layer.

The design goals are:

- TypeORM-first workflow;
- reviewable migration output;
- DataSource-scoped runtime access;
- NestJS-friendly module registration;
- production-minded docs and troubleshooting;
- clear limitations while the package is pre-1.0.

Feedback welcome, especially from teams already using TypeORM, NestJS, PostgreSQL,
or TimescaleDB.

## Internal BluePrime launch note

We have prepared `typeorm-timescaledb` for broader public feedback.

Recent work added or strengthened:

- documentation structure;
- quickstart and tutorial flows;
- Docker Compose local setup;
- runnable examples;
- API reference;
- query-layer docs;
- production guide;
- troubleshooting guide;
- package smoke tests;
- supply-chain trust checks;
- launch materials.

The main public message is:

`typeorm-timescaledb` brings TimescaleDB workflows into TypeORM with reviewable
migrations, NestJS support, typed query helpers, and a production-minded safety
model — without globally mutating TypeORM.

Before public posting, confirm the active release version, package smoke tests,
CI, supply-chain checks, and docs links.

## Reddit / forum style post

Title idea: **Using TimescaleDB from TypeORM with reviewable migrations**

We have been working on `typeorm-timescaledb`, a pre-1.0 TypeORM integration for
TimescaleDB.

The goal is to support common TimescaleDB workflows without hiding database
changes at runtime. TypeORM still creates the base table. The package adds the
supported TimescaleDB layer through generated migrations that can be reviewed and
committed.

Current focus:

- hypertable metadata through decorators;
- migration generation;
- retention and columnstore policy setup;
- NestJS integration;
- DataSource-scoped runtime helpers;
- typed query helpers for common time-series queries;
- production and troubleshooting docs.

This is not a full TimescaleDB wrapper yet, and unsupported config changes still
need manual migrations. We are looking for feedback from TypeORM / NestJS /
TimescaleDB users.

## Dev.to introduction

Headline options:

1. Using TimescaleDB with TypeORM through reviewable migrations
2. A TypeORM-first path to TimescaleDB hypertables
3. Bringing TimescaleDB workflows into TypeORM and NestJS

Opening paragraph:

TypeORM is a familiar way to model application data in TypeScript, but TimescaleDB
adds PostgreSQL-native time-series concepts that TypeORM does not model directly.
`typeorm-timescaledb` bridges that gap with entity metadata, reviewable migration
generation, scoped runtime helpers, and NestJS support.

Call to action:

Try the quickstart, run the Docker Compose example, and open feedback issues for
missing workflows or unclear docs.

## Launch hashtags / keywords

Use sparingly:

- TypeScript
- TypeORM
- PostgreSQL
- TimescaleDB
- NestJS
- time-series data
- database migrations
- open source

## Claims to avoid

Avoid:

- "Production-ready for every TimescaleDB workload."
- "Fully automatic schema diffing."
- "All TimescaleDB features supported."
- "No need to understand migrations."
- "Safe automatic rollback for all changes."

Prefer:

- "Production-minded safety model."
- "Reviewable migrations."
- "Supported TimescaleDB workflows."
- "Pre-1.0 and looking for feedback."
- "Manual migrations remain the right answer for unsupported or high-risk changes."
