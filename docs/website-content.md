> Content source of truth: this document should stay in sync with `README.md`,
> `CHANGELOG.md`, and `docs/feature-status.md`. Every capability described below
> is shipped as of v0.4.0 unless explicitly marked Planned. No live website or
> Figma file exists yet — this is the content a designer/developer should build
> the site from.

---

# Navigation

Getting Started · User Guide · API Reference · Development · Release Notes · GitHub · npm

---

# Landing Page (`/`)

## Hero

*Time-series data, typed like everything else in your app.*

[Get started](/getting_started)

`npm install typeorm-timescaledb typeorm pg reflect-metadata` · **v0.4.0** · [Release notes](/release_notes) · [View on GitHub](https://github.com/BluePrime-Technologies/typeorm-timescaledb)

## Meet typeorm-timescaledb

`typeorm-timescaledb` is a pre-1.0, actively maintained TimescaleDB integration for TypeORM. Hypertables, columnstore, retention, continuous aggregates, and a full typed hyperfunction query layer are all modeled as ordinary TypeORM entities — never hand-written SQL, never a second ORM to learn. It's free and open source, tested against real TimescaleDB in CI.

**Typed, not hand-written.**
Hypertables, columnstore, retention, and continuous aggregates are decorator options on an entity you'd write anyway — not a raw SQL file you maintain by hand.

**Honest about scope.**
Every capability in these docs is labeled Shipped, Release scope, or Planned. Nothing here claims more than the current release actually does.

**Safe by construction.**
No global mutation, ever. Every `DataSource` is isolated from every other — enforced by a CI gate, not just a convention.

[Learn more about the design principles →](/user_guide)

## One Import Surface

```ts
import {
  Entity,
  PrimaryColumn,
  Column,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
} from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})
export class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  @TimeColumn()
  @HypertablePrimaryKey()
  time!: Date;

  @Column({ type: 'text' })
  sensorId!: string;

  @Column({ type: 'double precision' })
  value!: number;
}
```

Entities, columns, relations, and the TimescaleDB extensions all come from one package — you never reach for raw `typeorm` alongside it.

## Additional Information

A dense info strip below the fold — six short boxes, each pointing somewhere real. This replaces a long scroll of marketing prose with the same thing Django's homepage does: prove there's substance here, then get out of the way.

**Latest release**
**v0.4.0** — continuous aggregates, downsampling, T-Digest percentiles, and a jobs API.
[Release notes](/release_notes) · [Documentation](/user_guide)

**Latest in the changelog**
- *v0.4.0* — completes the continuous-aggregate story; adds downsampling, operational introspection, and T-Digest percentiles.
- *v0.3.0* — expands typed `timescaledb_toolkit` aggregate coverage (stats, percentiles, counters, state tracking, heartbeat/liveness).
[More release notes →](/release_notes)

**New to typeorm-timescaledb?**
- [Installation](/getting_started)
- [Define your first hypertable](/getting_started)
[Getting started →](/getting_started)

**What's inside**
- [Hypertables, columnstore & retention](/user_guide)
- [Continuous aggregates](/user_guide)
- [Toolkit aggregate query layer](/user_guide)
- [Migration CLI](/user_guide)
[Explore the user guide →](/user_guide)

**Get involved**
[Issue tracker](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues) — report bugs, request features
[Good first issues](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — a place to start
[Development guide →](/development)

**Get help**
[Open an issue](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues) — the only support channel right now; no Discord or forum yet
[Read the docs](/user_guide)

---

# Getting Started (`/getting_started`)

## Prerequisites

- Node.js `^20.19.0 || >=22.12.0`
- TypeORM `^0.3.20 || ^1.0.0`
- A Postgres database with TimescaleDB `>= 2.18` installed
- `timescaledb_toolkit` installed if you plan to use toolkit-backed aggregates or downsampling (candlesticks, stats, percentiles, counters, state tracking, T-Digest, LTTB/ASAP)

## Install

```bash
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Ships dual ESM + CJS with full type definitions.

## 1. Define an Entity

```ts
import {
  Entity,
  PrimaryColumn,
  Column,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
} from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})
export class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  @TimeColumn()
  @HypertablePrimaryKey()
  time!: Date;

  @Column({ type: 'text' })
  sensorId!: string;

  @Column({ type: 'double precision' })
  value!: number;
}
```

## 2. Prepare the Database and DataSource

`typeorm-timescaledb` adds the TimescaleDB layer on top — your TypeORM setup still owns the base `CREATE TABLE` step, through `synchronize` or a normal TypeORM migration.

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Make sure your DataSource's `migrations` path includes wherever you'll generate TimescaleDB migrations to:

```ts
export const AppDataSource = new DataSource({
  // ...the rest of your DataSource options
  migrations: ['src/migrations/*.{ts,js}'],
});
```

## 3. Generate the TimescaleDB Migration

```bash
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations
```

A `.ts` DataSource needs a TypeScript loader — run the CLI under [`tsx`](https://tsx.is) or [`ts-node`](https://typestrong.org/ts-node/), or point `-d` at a compiled `.js` DataSource.

## 4. Apply It

```bash
npx typeorm-timescaledb run -d src/data-source.ts
```

`generate` / `run` / `revert` / `status` are all available.

## 5. Use the Runtime Context

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(dataSource);
const readings = ts.getRepository(Reading);
await ts.assertSchema(); // boot-time drift check, not a full diff engine
```

## Core Concepts

**No global mutation.** Everything is scoped to the `DataSource` you pass in — no prototype patching, no global singletons.

**Migrations are additive.** They add supported configuration idempotently. They do not remove or alter existing configuration — that's still a hand-written migration.

**One import surface.** Entity decorators, `DataSource`, repositories, and every TimescaleDB primitive come from `typeorm-timescaledb`.

**Base table ownership.** TypeORM remains responsible for creating and changing base tables; this package adds the TimescaleDB layer on top.

## Next

For a full local walkthrough with Docker, complete files, expected output, and insert/query verification, see the 10-minute tutorial in the repo's `docs/tutorial.md`. Then continue to the [User Guide](/user_guide).

---

# User Guide (`/user_guide`)

The user guide covers every shipped capability in depth, with working code for each. Looking for exact signatures? See the [API Reference](/reference).

## Hypertables, Columnstore & Retention

Turn an entity into a hypertable, and declare columnstore compression and retention alongside it — all in one decorator.

```ts
@Entity('reading')
@Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})
export class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  @TimeColumn()
  @HypertablePrimaryKey()
  time!: Date;

  @Column({ type: 'text' })
  sensorId!: string;

  @Column({ type: 'double precision' })
  value!: number;
}
```

Space (hash) partitioning is also supported via `@Hypertable` options.

**What this does not do:** generated hypertable conversion assumes the base table is empty. If it already has rows, write a hand-authored migration that handles the existing data explicitly.

## Migrations & CLI

Migrations are additive and desired-state oriented — they apply supported configuration idempotently, and generated `down()` methods are never destructive.

```bash
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations
npx typeorm-timescaledb run -d src/data-source.ts
npx typeorm-timescaledb status -d src/data-source.ts
npx typeorm-timescaledb revert -d src/data-source.ts
```

**What this does not do:** removing or altering existing TimescaleDB configuration — dropping a retention policy, changing a chunk interval, reworking dimensions — is not auto-diffed. Do that by hand for now. A full entity-to-database diff engine is planned but not shipped.

## Query Layer — Hyperfunctions

Typed `time_bucket` queries, gap-filling, and a fluent lower-level builder.

```ts
const buckets = await readings.getTimeBucket({
  interval: '1 hour',
  metric: { fn: 'avg', column: 'value' },
  range: { start, end },
});
```

Supported metric functions: `avg`, `sum`, `min`, `max`, `count`, `first`, `last`. Gap-filling is available via `time_bucket_gapfill` with `locf` or `interpolate`. For lower-level access, `repo.timescaleQueryBuilder()` exposes `timeBucket()`, `timeBucketGapfill()`, `first()`, `last()`, `histogram()`, `locf()`, `interpolate()`, `getRawMany()`, `getRawOne()`, and `getSql()`.

**What this does not do:** this is a query convenience layer over hyperfunctions, not a general-purpose SQL query builder replacement — use TypeORM's own query builder for non-TimescaleDB queries.

## Toolkit Aggregates

Typed helpers over the stable `timescaledb_toolkit` aggregate families:

| Family | Methods |
|---|---|
| Candlesticks | `getCandlesticks()` |
| Approximate distinct count | `approxCountDistinct()` |
| Statistics | `getStats()`, `getRegression()` |
| Percentiles | `getPercentiles()`, `getPercentileRanks()` (UddSketch); `getTDigestPercentiles()`, `getTDigestPercentileRanks()` (T-Digest) |
| Counters | `getCounterAgg()` |
| Time-weighted average | `getTimeWeight()` |
| State tracking | `getStateDurations()`, `getStateTimeline()`, `getStateAt()`, `getStatePeriods()` |
| Most-common-values | `getMostCommonValues()`, `getTopN()` |
| Liveness / uptime | `getHeartbeatHealth()`, `getLiveRanges()`, `getDeadRanges()`, `isLiveAt()` |

```ts
const candles = await readings.getCandlesticks({
  interval: '1 hour',
  priceColumn: 'value',
  volumeColumn: 'volume',
});
```

Every toolkit-backed method requires `timescaledb_toolkit` and fails fast with `TSDB_TOOLKIT_MISSING` if it isn't installed.

**What this does not do:** `gauge_agg`, `freq_agg`, and `compact_state_agg` still live in the toolkit's experimental schema and aren't surfaced yet. Not every stable Toolkit aggregate is covered.

## Continuous Aggregates

Declare a materialized rollup on its own class — not a TypeORM `@Entity`, since a continuous aggregate is a view, not a table.

```ts
@ContinuousAggregate({
  name: 'hourly_reading_avg',
  source: Reading,
  bucket: '1 hour',
  refresh: { startOffset: '3 days', endOffset: '1 hour' },
})
class HourlyReadingAvg {
  @BucketColumn()
  bucket!: Date;

  @AggregateColumn({ fn: 'avg', column: 'value' })
  avgValue!: number;
}
```

Hierarchical continuous aggregates are supported — a `@ContinuousAggregate` whose `source` is another `@ContinuousAggregate` — with topological create/drop ordering. Refresh policies are automatic when `refresh` is set. Drift detection via `assertSchema()` covers continuous aggregates and their policies when you opt in by passing them explicitly.

**What this does not do:** `@RollupColumn` ergonomic sugar for hierarchical rollups isn't shipped yet (hierarchical rollups are already expressible today via `@AggregateColumn`).

## Downsampling

```ts
const points = await readings.downsampleLTTB({
  valueColumn: 'value',
  resolution: 500,
});
```

`downsampleLTTB()` and `downsampleASAP()` (toolkit `lttb` / `asap_smooth`) return typed `{ time, value }[]`, sized to a target point count between 3 and 1,000,000. Requires `timescaledb_toolkit`.

## Operational Introspection & Jobs

DataSource-wide, read-only accessors over `timescaledb_information.*`, plus a jobs API — available on the runtime context, not a repository.

```ts
const ts = createTimescale(dataSource);
const hypertables = await ts.listHypertables();
const chunks = await ts.listChunks({ hypertable: 'reading' });
await ts.runJob(jobId);
```

Also available: `listContinuousAggregates()`, `listJobs()`, `getJobStats()`, and the user-defined action jobs API `addJob()` / `alterJob()` / `deleteJob()`. These run outside any surrounding transaction, since the underlying TimescaleDB procedures can't run inside one.

## Drift Detection

```ts
await ts.assertSchema({ mode: 'warn', logger: console.warn });
```

Checks the live database against your `@Hypertable` entities — and, if you pass them explicitly, your `@ContinuousAggregate` classes. Default mode `'assert'` throws on drift; `'warn'` logs it and returns it instead.

**What this does not do:** this is a scoped sanity check, not a full database diff engine.

## NestJS Integration

```ts
import { TimescaleModule, InjectTimescaleRepository } from 'typeorm-timescaledb/nestjs';

@Module({
  imports: [
    TimescaleModule.forRoot({ dataSource, assert: 'assert' }),
    TimescaleModule.forFeature([Reading]),
  ],
})
export class AppModule {}
```

Multiple TimescaleDB DataSources are supported by passing a `name` to `forRoot` / `forFeature` / `@InjectTimescaleRepository`.

## Why typeorm-timescaledb

TypeORM plus hand-written SQL migrations can already get TimescaleDB working. Here's what this library adds on top.

| Capability | Raw TypeORM + hand-written SQL | typeorm-timescaledb |
|---|---|---|
| Hypertable creation | Manual `create_hypertable()` SQL, undocumented per project | Declarative `@Hypertable()` decorator |
| Columnstore / retention | Hand-written SQL, easy to drift from entity definitions | Declared alongside the entity, versioned with it |
| Continuous aggregates | Raw SQL views managed outside TypeORM | Typed `@ContinuousAggregate` classes with migration codegen |
| Query layer | Hand-written hyperfunction SQL | Typed `time_bucket`, gap-filling, toolkit aggregates, downsampling |
| Migration model | Whatever convention each team invents | One documented, additive, desired-state model |
| Multi-DataSource safety | No enforced guarantee | No global mutation — CI-gated |
| Cross-store references | Manual, unvalidated | Planned, not shipped yet |

`typeorm-timescaledb` is a pre-1.0, actively maintained package, tested against real TimescaleDB in CI.

---

# API Reference (`/reference`)

Complete public surface for `typeorm-timescaledb`, current as of v0.4.0. Assumes you already understand the concepts — start with the [User Guide](/user_guide) if you're new.

## Import Paths

```ts
import {
  Column, DataSource, Entity, Hypertable, HypertablePrimaryKey,
  PrimaryColumn, TimeColumn, createTimescale,
} from 'typeorm-timescaledb';

import { TimescaleModule } from 'typeorm-timescaledb/nestjs';

import { statsAgg1DExpr } from '@blueprime/timescaledb-core';
```

## Sections

- **Decorators & metadata helpers** — `Hypertable()`, `TimeColumn()`, `HypertablePrimaryKey()`, `getTimescaleMetadata()`, `hasTimescaleMetadata()`.
- **Continuous aggregate decorators** — `ContinuousAggregate()`, `BucketColumn()`, `GroupColumn()`, `AggregateColumn()`, `getContinuousAggregateMeta()`, `hasContinuousAggregateMeta()`.
- **Runtime context** — `createTimescale(dataSource)`, the `TimescaleContext` interface, `TimescaleRepository<T>`.
- **Query layer** — `getTimeBucket()`, `timescaleQueryBuilder()`, result-coercion helpers (`toNumber`, `toNumberOrNull`, `toBigIntString`, `toDate`, `toNumberArray`, `mapRawRows`).
- **Toolkit-backed methods** — every method listed under [Toolkit Aggregates](/user_guide#toolkit-aggregates) and [Downsampling](/user_guide#downsampling) in the User Guide, plus `assertToolkit()`.
- **Operational introspection & jobs** — `listHypertables()`, `listChunks()`, `listContinuousAggregates()`, `listJobs()`, `getJobStats()`, `runJob()`, `addJob()`, `alterJob()`, `deleteJob()`.
- **Schema assertion** — `assertSchema()`, `AssertSchemaOptions`.
- **Migration generation** — `generateTimescaleMigration()`, `renderTimescaleMigration()`, `createTimescaleMigration()`, `GenerateMigrationOptions`, `GeneratedMigration`.
- **CLI** — `generate` / `run` / `revert` / `status` (not part of the importable library surface).
- **NestJS API** — `TimescaleModule.forRoot()`, `TimescaleModule.forFeature()`, `InjectTimescaleRepository()`, `InjectTimescaleContext()`, `getTimescaleRepositoryToken()`, `getTimescaleContextToken()`, `DEFAULT_TIMESCALE_NAME`.
- **Core metadata & query types** — `HypertableOptions`, `ColumnstoreOptions`, `RetentionOptions`, `SpacePartitionOptions`, `TimescaleEntityMetadata`, `DriftItem`, and the continuous-aggregate/query-layer option and result types.
- **Validation & errors** — `parseHypertableOptions()`, `validateHypertableMetadata()`, `TimescaleError`, `TimescaleErrorCode`.

## What Is Not Part of This API

Automatic destructive migrations, automatic live configuration rewrites, `@RollupColumn` ergonomic sugar, validated cross-store references, experimental toolkit aggregates (`gauge_agg`, `freq_agg`, `compact_state_agg`), stable Toolkit aggregates not listed above, and complete TimescaleDB feature coverage are not part of the current public API.

[Search the reference above, or browse by section.]

---

# Development (`/development`)

This project is built primarily for BluePrime's own use, but contributions are welcome.

## Local Setup

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

- **Node:** `>= 20.19` or `>= 22.12`
- **Package manager:** pnpm, via corepack
- Integration tests require Docker (Testcontainers spins up a real TimescaleDB)

## Ground Rules

1. **Every change ships with tests.** No feature, fix, or change merges without tests covering happy paths, error cases, and edge cases.
2. **No global mutation.** Nothing may patch `DataSource.prototype`, `Repository.prototype`, or any shared global. The two-DataSource isolation test must stay green.
3. **No destructive rollbacks.** Migration `down()` must never delete data.
4. **Conventional Commits.** Commit messages follow Conventional Commits — they drive releases.

## Pull Requests

Open an issue first and reference it in the PR. Keep PRs focused. CI — lint, typecheck, unit, and the integration matrix — must be green before merge.

[Find an open issue →](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues)

## License & Sign-off

Licensed under **Apache-2.0** (see `LICENSE` and `NOTICE`). By contributing, you agree your contributions are licensed under Apache-2.0. Every commit must carry a `Signed-off-by` trailer per the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).

## Maintainer

Built and maintained by **Miracle Adebunmi** ([@madebunmi-prime](https://github.com/madebunmi-prime)), under **BluePrime Technologies**.

## Packages

| Package | Description |
|---|---|
| `typeorm-timescaledb` | The TypeORM integration: decorators, repository, migrations, CLI, NestJS module. |
| `@blueprime/timescaledb-core` | ORM-agnostic SQL/DDL generation, metadata model, identifier safety. |

---

# Release Notes (`/release_notes`)

## v0.4.0 — 2026-07-09

Minor release. Completes the continuous-aggregate story and adds downsampling, operational introspection, and T-Digest percentiles. No breaking changes.

**Added:** typed continuous aggregates (`@ContinuousAggregate`/`@BucketColumn`/`@GroupColumn`/`@AggregateColumn`) with migration codegen; automatic refresh policies; hierarchical continuous aggregates; CAGG drift detection; downsampling (`downsampleLTTB`/`downsampleASAP`); informational views (`listHypertables`, `listChunks`, `listContinuousAggregates`, `listJobs`, `getJobStats`); the jobs API (`runJob`, `addJob`, `alterJob`, `deleteJob`); T-Digest percentiles.

**Fixed:** `approxCountDistinct` over an empty set now returns `"0"` instead of throwing.

## v0.3.0 — 2026-06-28

Minor release. Expanded typed `timescaledb_toolkit` aggregate coverage. No breaking changes.

**Added:** `getStats()` / `getRegression()` (statistics), `getPercentiles()` / `getPercentileRanks()` (UddSketch percentiles), `getCounterAgg()` (counters), `getTimeWeight()` (time-weighted average), `getStateDurations()` / `getStateTimeline()` / `getStateAt()` / `getStatePeriods()` (state tracking), `getMostCommonValues()` / `getTopN()` (most-common-values), `getHeartbeatHealth()` / `getLiveRanges()` / `getDeadRanges()` / `isLiveAt()` (liveness/uptime).

**Fixed:** default time-column resolution across toolkit helpers for entities mapping `@TimeColumn` through `@Column({ name })`.

## v0.2.0 — 2026-06-12

Minor release. A backward-compatible typed query layer on top of the 0.1.x schema foundation. No breaking changes.

**Added:** `getTimeBucket()` and `timescaleQueryBuilder()`; core hyperfunctions (`time_bucket` with timezone/origin/offset, `first`/`last`, `histogram`); gap-filling (`time_bucket_gapfill` with `locf`/`interpolate`); initial toolkit helpers (`getCandlesticks()`, `approxCountDistinct()`); toolkit-presence detection (`TSDB_TOOLKIT_MISSING`); typed raw-result coercion helpers.

## v0.1.1 — 2026-06-11

Documentation only — rewrote the README's "Why this exists" section and clarified pre-1.0 scope.

## v0.1.0 — 2026-06-11

Initial public release — the schema foundation.

**Added:** `@Hypertable`, `@TimeColumn`, `@HypertablePrimaryKey` decorators (chunk interval, columnstore, retention, space partitioning); migration generation + CLI (`generate`/`run`/`revert`/`status`); per-DataSource runtime access (`createTimescale`) and drift detection (`assertSchema`); NestJS module; unified import surface; dual ESM + CJS builds; `@blueprime/timescaledb-core`.

[View all releases on GitHub →](https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases)

## Roadmap

Directional, not a commitment or a timeline. Pulled from the project's own feature-status tracking.

- `@RollupColumn` ergonomic sugar for hierarchical continuous-aggregate rollups (hierarchical rollups already work today via `@AggregateColumn`).
- `gauge_agg`, `freq_agg`, and `compact_state_agg` — still in the toolkit's experimental schema.
- Stable Toolkit aggregates not yet covered by the typed query layer.
- A full, safe entity-to-database diff engine.
- Validated cross-store references.
- Complete TimescaleDB feature coverage.

Automatic destructive migrations are not planned as a public promise — any change that could drop data or destructively alter existing TimescaleDB objects will always require an explicit, hand-written migration.

---

# Footer

**typeorm-timescaledb**
Apache-2.0 licensed. Maintained by Miracle Adebunmi ([@madebunmi-prime](https://github.com/madebunmi-prime)) under BluePrime Technologies.

**Learn**
[User Guide](/user_guide) · [API Reference](/reference) · [Getting Started](/getting_started) · [Release Notes](/release_notes)

**Get Involved**
[Development Guide](/development) · [Issue Tracker](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues) · [Good First Issues](https://github.com/BluePrime-Technologies/typeorm-timescaledb/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

**Package**
[GitHub](https://github.com/BluePrime-Technologies/typeorm-timescaledb) · [npm](https://www.npmjs.com/package/typeorm-timescaledb) · [License](https://github.com/BluePrime-Technologies/typeorm-timescaledb/blob/main/LICENSE)

© 2026 BluePrime Technologies. Released under the Apache-2.0 License.

---

# 404 Page

That page doesn't exist. Try [Home](/), [Getting Started](/getting_started), or [search the repository](https://github.com/BluePrime-Technologies/typeorm-timescaledb).
