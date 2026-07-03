# Launch blog post draft

> Working title: Introducing `typeorm-timescaledb`: TimescaleDB workflows for TypeORM

TypeORM is a familiar choice for TypeScript teams building on PostgreSQL. TimescaleDB is a powerful extension for time-series workloads. But using them together often leaves developers crossing a gap: TypeORM understands entities and migrations, while TimescaleDB features such as hypertables, retention policies, columnstore configuration, and toolkit-backed analytics live closer to raw SQL.

`typeorm-timescaledb` is BluePrime's TypeORM-first integration for TimescaleDB. It helps developers model supported TimescaleDB behavior in TypeScript, generate reviewable migrations, and keep TimescaleDB-specific database changes explicit.

The package is intentionally production-minded. It does not globally mutate TypeORM. It does not silently rewrite your database at application startup. It does not pretend every TimescaleDB configuration change can be safely auto-diffed. Instead, it keeps the boundary clear:

- TypeORM creates and owns the base relational table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.
- Generated migrations are normal TypeORM migration files that can be reviewed, committed, tested, and deployed through your existing process.

## Why we built it

Teams using TypeORM with TimescaleDB often end up with two separate sources of truth:

1. TypeORM entities and migrations for the normal PostgreSQL model.
2. Hand-written TimescaleDB SQL for hypertables, retention policies, compression or columnstore settings, and time-series queries.

That split works, but it is easy for it to become inconsistent. The entity says one thing, the database does another, and new developers have to learn which SQL files are safe to edit.

`typeorm-timescaledb` gives that workflow a clearer shape. You keep TypeORM as your ORM. You keep migrations reviewable. You add TimescaleDB metadata and helper APIs where they make sense.

## What it supports today

The current pre-1.0 line focuses on practical TypeORM + TimescaleDB workflows:

- hypertable metadata with decorators;
- time-column metadata;
- generated TimescaleDB migrations;
- retention policy setup;
- columnstore policy setup;
- optional space partition metadata;
- per-DataSource runtime access;
- `assertSchema()` drift checks for supported TimescaleDB state;
- CLI commands for migration generation and execution;
- NestJS integration;
- ESM and CommonJS package exports;
- typed query helpers for time buckets, gapfill, candlesticks, approximate distinct counts, and supported toolkit-backed helper families.

## A small example

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm-timescaledb';
import { Hypertable, TimeColumn } from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  timeColumn: 'time',
  chunkInterval: '1 day',
  retention: { dropAfter: '30 days' },
})
export class Reading {
  @PrimaryColumn('text')
  sensorId!: string;

  @TimeColumn()
  time!: Date;

  @Column('double precision')
  value!: number;
}
```

From there, the package can generate a TypeORM migration that adds the supported TimescaleDB layer for the entity. Your team reviews that migration before applying it.

## Why reviewable migrations matter

Database changes should be visible. In production, a migration is not just an implementation detail; it is an operational event.

That is why `typeorm-timescaledb` does not silently apply TimescaleDB changes at runtime. The generated files can be read, discussed, tested locally, checked in CI, and deployed through the same pipeline as your other database changes.

Generated `down()` methods are conservative by design. Some TimescaleDB operations cannot be safely reversed automatically without data loss or expensive data movement. When a change needs business context, use a hand-written migration.

## NestJS support

For NestJS teams, the package includes a module and repository-injection helpers designed for explicit DataSource wiring. That matters in applications with multiple database connections or analytics-specific DataSources.

The integration is designed to avoid global TypeORM mutation. You register the DataSource you want to use, then inject the Timescale-aware repository for the entity and context you need.

## What is not promised yet

`typeorm-timescaledb` is still pre-1.0. It is useful today, but it should be adopted with clear expectations.

The package does not yet promise:

- complete TimescaleDB feature coverage;
- a full entity-to-database diff engine;
- automatic destructive migrations;
- automatic live configuration rewrites for every metadata change;
- automatic conversion plans for populated production tables;
- support for every TimescaleDB Toolkit aggregate.

For high-risk or unsupported changes, write a normal TypeORM migration and include the reviewed TimescaleDB SQL explicitly.

## Getting started

Start with the docs in this order:

1. Installation
2. Quickstart
3. 10-minute tutorial
4. Docker Compose local setup
5. Runnable quickstart example
6. Production guide
7. Troubleshooting guide

The best first test is a local TimescaleDB database, a single entity, a generated migration, and one query that proves the hypertable exists.

## What we want feedback on

We are especially interested in feedback from teams using:

- TypeORM with PostgreSQL;
- NestJS and multiple DataSources;
- TimescaleDB hypertables in production;
- review-heavy database migration workflows;
- retention, columnstore, and toolkit-backed analytics.

If a workflow is unclear, if an error message is confusing, or if a supported TimescaleDB pattern is missing, open an issue or discussion with a minimal reproduction.

## Closing

`typeorm-timescaledb` is about bringing TimescaleDB workflows closer to TypeORM without hiding database change management. It gives TypeScript teams a practical path from entity metadata to reviewable TimescaleDB migrations, with safety boundaries that production teams can reason about.

Try it locally, read the generated migration, and tell us where the workflow should go next.
