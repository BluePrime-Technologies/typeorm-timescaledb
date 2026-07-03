# Tutorial draft: NestJS with typeorm-timescaledb

Working title: **Using TimescaleDB in a NestJS + TypeORM app**

## Goal

Show NestJS developers how to register `typeorm-timescaledb`, inject TimescaleDB
repositories, and avoid common multi-DataSource mistakes.

This article should be a public-facing companion to the NestJS guide.

## Why NestJS users care

NestJS teams often rely on dependency injection and module boundaries. A
TimescaleDB integration should respect those boundaries instead of globally
patching TypeORM behavior.

`typeorm-timescaledb` is designed around scoped runtime access. You pass in a
TypeORM DataSource, register it with the NestJS module, and inject repositories
for the entities that need TimescaleDB behavior.

## Prerequisites

- A NestJS app.
- TypeORM configured with PostgreSQL.
- A TimescaleDB database.
- `timescaledb` extension enabled.
- `typeorm-timescaledb` installed.

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

## Define a hypertable entity

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

## Register the module

For a default Timescale context:

```ts
import { Module } from '@nestjs/common';
import { TimescaleModule } from 'typeorm-timescaledb/nestjs';
import { AppDataSource } from './data-source.js';
import { Reading } from './reading.entity.js';

@Module({
  imports: [
    TimescaleModule.forRoot({ dataSource: AppDataSource }),
    TimescaleModule.forFeature([Reading]),
  ],
})
export class ReadingsModule {}
```

`forRoot()` registers the DataSource-backed Timescale context. `forFeature()`
registers repositories for entities in that context.

## Inject a repository

```ts
import { Injectable } from '@nestjs/common';
import {
  InjectTimescaleRepository,
  TimescaleRepository,
} from 'typeorm-timescaledb/nestjs';
import { Reading } from './reading.entity.js';

@Injectable()
export class ReadingsService {
  constructor(
    @InjectTimescaleRepository(Reading)
    private readonly readings: TimescaleRepository<Reading>,
  ) {}
}
```

From there, use the repository for supported TimescaleDB-aware operations and the
query layer.

## Use named contexts for multiple DataSources

If your app has more than one DataSource, name the Timescale context explicitly:

```ts
TimescaleModule.forRoot({
  name: 'analytics',
  dataSource: AnalyticsDataSource,
});

TimescaleModule.forFeature([Reading], 'analytics');
```

Inject with the same name:

```ts
@InjectTimescaleRepository(Reading, 'analytics')
private readonly readings: TimescaleRepository<Reading>;
```

The same context name must be used for `forRoot()`, `forFeature()`, and injection.
This is the most important NestJS troubleshooting rule.

## Migration workflow still matters

The NestJS module does not replace migrations.

Use the same migration workflow as any TypeORM project:

1. TypeORM creates the base table.
2. `typeorm-timescaledb` generates the supported TimescaleDB migration.
3. The team reviews and commits the generated migration.
4. Migrations run through the normal deployment pipeline.
5. `assertSchema()` can be used as a targeted sanity check.

## Common mistakes

### Registering `forFeature()` without matching `forRoot()`

If injection fails, confirm the module graph includes a matching `forRoot()` for
that context.

### Mismatched context names

If `forRoot()` uses `analytics`, then `forFeature()` and
`@InjectTimescaleRepository()` must also use `analytics`.

### Expecting global TypeORM mutation

The package does not globally mutate TypeORM. If a repository is not registered
for the current module/context, wire it through NestJS explicitly.

### Treating NestJS setup as database setup

NestJS module registration does not create the TimescaleDB extension, create base
tables, or run migrations. Keep database setup explicit.

## Production notes

For production NestJS apps:

- keep DataSource configuration centralized;
- avoid `synchronize: true`;
- run migrations before application rollout;
- use named contexts for multiple DataSources;
- use `assertSchema()` where startup drift checks are useful;
- use manual migrations for unsupported config changes.

## Where to go next

- NestJS guide
- Production guide
- Troubleshooting guide
- Migration guide
- Query layer guide
