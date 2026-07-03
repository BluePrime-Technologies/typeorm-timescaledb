# Launch blog post draft

Working title: **Introducing typeorm-timescaledb: TimescaleDB workflows for TypeORM**

## Audience

Backend developers, TypeORM users, NestJS teams, and engineering teams who want
TimescaleDB features without leaving their TypeORM workflow.

## Draft

Time-series data is common in modern applications: sensor readings, analytics
metrics, event streams, trading data, logs, audits, and product telemetry all
need to be written and queried over time.

PostgreSQL is already a common choice for application data, and TimescaleDB adds
powerful time-series capabilities on top of PostgreSQL. But if your application
uses TypeORM, adopting TimescaleDB usually creates a gap: TypeORM understands
entities, columns, repositories, and migrations, while TimescaleDB adds concepts
such as hypertables, chunk intervals, retention policies, columnstore settings,
and hyperfunction queries.

`typeorm-timescaledb` exists to close that gap.

It is a TypeORM-first integration for TimescaleDB. You model your base tables
with normal TypeORM entities, add TimescaleDB metadata with decorators, generate
reviewable migrations, and keep using TypeORM's DataSource and repository model.

## Why we built it

The goal is not to hide TimescaleDB. The goal is to make TimescaleDB explicit,
reviewable, and easier to use from TypeORM projects.

A production database workflow should not depend on invisible runtime magic. When
a table becomes a hypertable, or when retention and columnstore policy decisions
are made, the team should be able to inspect those changes before they reach a
real database.

That is why `typeorm-timescaledb` uses a migration-driven model:

- TypeORM creates the base relational table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.
- Generated migrations are committed and reviewed.
- Generated rollback behavior is intentionally conservative and non-destructive.
- Runtime helpers are scoped to the DataSource you pass in.

## What it supports today

The current package focuses on practical TimescaleDB workflows for TypeORM apps:

- hypertable metadata through decorators;
- time-column metadata;
- migration generation for supported TimescaleDB setup;
- retention policy setup;
- columnstore configuration and policy setup;
- optional space partitioning;
- per-DataSource runtime access;
- schema sanity checks with `assertSchema()`;
- NestJS module and repository helpers;
- ESM and CJS package output;
- typed query helpers for time buckets, gapfill, candlesticks, approximate
  distinct counts, and supported toolkit-backed helpers.

The package avoids global TypeORM mutation. This matters for applications with
multiple DataSources, test environments, and NestJS modules where implicit global
patching can create surprising behavior.

## What it does not promise yet

`typeorm-timescaledb` is pre-1.0, so the public message should stay precise.

It does not claim to be a full TimescaleDB feature wrapper. It does not promise a
complete automatic diff engine for every live TimescaleDB configuration change.
It does not silently rewrite production databases at runtime. It does not treat
destructive rollback as safe by default.

For unsupported or high-risk changes, teams should write explicit TypeORM
migrations and review them like any other production database change.

## Quick example

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm-timescaledb';
import { Hypertable, TimeColumn } from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({ timeColumn: 'time' })
export class Reading {
  @PrimaryColumn('timestamptz')
  @TimeColumn()
  time!: Date;

  @PrimaryColumn('text')
  sensorId!: string;

  @Column('double precision')
  value!: number;
}
```

From there, generate and review the TimescaleDB migration, run it through your
normal migration pipeline, and verify the database shape with the production and
troubleshooting guides.

## How to start

Start with the documentation in this order:

1. Installation
2. Quickstart
3. 10-minute tutorial
4. Docker Compose local setup
5. Runnable quickstart example
6. Production guide
7. Troubleshooting guide

If you use NestJS, read the NestJS guide after the quickstart.

## Who should try it

Try `typeorm-timescaledb` if:

- your application already uses TypeORM;
- you want TimescaleDB hypertables and policies in a TypeORM project;
- you prefer reviewable migrations over runtime mutation;
- you need NestJS-friendly integration;
- you want typed query helpers for common time-series patterns.

You may not need it if you are not using TypeORM, if you want to manage all
TimescaleDB SQL by hand, or if you need full coverage of every TimescaleDB feature
right now.

## Closing

`typeorm-timescaledb` is built around a simple idea: TypeORM should continue to
own the relational table model, while TimescaleDB-specific behavior should be
added explicitly, safely, and reviewably.

We are sharing it as a pre-1.0 package and looking for feedback from TypeORM,
NestJS, and TimescaleDB users.

If you try it, start with the quickstart, run the local Docker example, and open
issues for unclear docs, missing examples, or workflows that should be supported
next.
