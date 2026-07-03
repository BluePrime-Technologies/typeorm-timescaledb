# Launch blog post draft

Working title: **Introducing typeorm-timescaledb: TypeORM-first TimescaleDB workflows**

## Audience

TypeScript backend developers, TypeORM users, NestJS teams, and developers who
want TimescaleDB features without leaving their existing TypeORM workflow.

## Draft

Time-series data often starts inside a normal application database. A product
begins with events, readings, metrics, logs, or measurements, and the application
team reaches for the tools it already knows: TypeScript, PostgreSQL, TypeORM, and
sometimes NestJS.

Then the data grows. Query patterns become time-based. Retention matters.
Compression or columnstore policies matter. Bucketing, gap-filling, and
TimescaleDB hyperfunctions become useful. But the application still wants a
TypeORM-first development experience.

`typeorm-timescaledb` is BluePrime's TypeORM integration for TimescaleDB. It lets
teams describe supported TimescaleDB behavior next to TypeORM entities, generate
reviewable migrations, and use typed helpers for common time-series query
patterns.

The package is designed around a clear boundary:

- TypeORM owns the base relational table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.

That means the package does not try to replace TypeORM or silently mutate TypeORM
internals. Instead, it works with TypeORM's migration workflow and makes
TimescaleDB-specific changes visible as code.

## What it supports today

The current pre-1.0 package focuses on the workflows needed to move from a normal
TypeORM entity to a TimescaleDB-backed time-series model:

- hypertable metadata through decorators;
- generated TimescaleDB migrations;
- retention policy setup;
- columnstore policy setup;
- optional space partitioning;
- per-DataSource runtime access;
- schema sanity checks with `assertSchema()`;
- NestJS module and repository integration;
- dual ESM/CJS package output;
- typed query helpers for time buckets, gapfill, candlesticks, histograms,
  approximate counts, and supported toolkit-backed query families.

The package also includes documentation for local Docker setup, a 10-minute
tutorial, runnable examples, production guidance, troubleshooting, API reference,
and supply-chain trust signals.

## Why reviewable migrations matter

Database changes should be visible before they are applied. That is especially
true for TimescaleDB operations that affect hypertables, policies, jobs,
partitioning, or long-lived production data.

`typeorm-timescaledb` generates migration files that teams can read, commit,
review, and deploy through their existing pipeline. The generated files are not
hidden runtime side effects.

The rollback model is intentionally conservative. Generated `down()` methods are
non-destructive by default and should not be treated as a promise that every
TimescaleDB operation can be safely reversed automatically. When a change needs
business context, data movement, or destructive behavior, teams should write a
manual migration.

## A small example

A TypeORM entity can declare TimescaleDB intent with decorators:

```ts
import { Column, Entity, PrimaryColumn } from "typeorm-timescaledb";
import { Hypertable, TimeColumn } from "typeorm-timescaledb";

@Entity()
@Hypertable({ timeColumn: "time", chunkTimeInterval: "1 day" })
export class Reading {
  @PrimaryColumn("timestamptz")
  @TimeColumn()
  time!: Date;

  @PrimaryColumn("text")
  sensorId!: string;

  @Column("double precision")
  value!: number;
}
```

TypeORM creates the base table. `typeorm-timescaledb` generates the TimescaleDB
migration that adds the supported hypertable layer.

## Where to start

Start with the documentation in this order:

1. Installation
2. Quickstart
3. 10-minute tutorial
4. Docker Compose local setup
5. Runnable quickstart example
6. Production guide
7. Troubleshooting guide
8. API reference

## What is intentionally not promised yet

This project is pre-1.0. The current package does not claim complete TimescaleDB
feature coverage, a full live schema reconcile engine, or automatic destructive
migrations.

Some production configuration changes, such as changing existing chunk intervals,
reworking dimensions, or replacing existing policies, should be handled with
hand-written migrations and reviewed by the team operating the database.

## Closing

`typeorm-timescaledb` is for teams that want to keep a TypeORM-first workflow
while adopting supported TimescaleDB capabilities in a reviewable,
production-minded way.

Try it, read the docs, run the examples, and open issues for gaps, confusing
errors, or real-world workflows you want the package to support next.

## Links to include before publishing

- GitHub repository
- npm package: `typeorm-timescaledb`
- Documentation index
- Quickstart
- 10-minute tutorial
- Production guide
- Troubleshooting guide
