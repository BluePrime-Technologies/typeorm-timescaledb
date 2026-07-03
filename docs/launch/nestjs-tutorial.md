# Tutorial: Use TimescaleDB with TypeORM in NestJS

This launch tutorial is for NestJS teams that already use TypeORM and want to add
supported TimescaleDB workflows.

## Goal

Show how to register `typeorm-timescaledb` in a NestJS application, inject a
Timescale repository, and avoid common multi-DataSource mistakes.

## Prerequisites

- A NestJS application
- A configured TypeORM `DataSource`
- PostgreSQL with TimescaleDB enabled
- `typeorm-timescaledb` installed

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

## 1. Define an entity

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm-timescaledb';
import { Hypertable, TimeColumn } from 'typeorm-timescaledb';

@Entity()
@Hypertable({
  timeColumn: 'time',
  chunkTimeInterval: '1 day',
})
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

TypeORM still owns the base table. The TimescaleDB metadata is used by
`typeorm-timescaledb` for supported TimescaleDB migration generation and runtime
helpers.

## 2. Register the Timescale module

For the default context:

```ts
import { Module } from '@nestjs/common';
import { TimescaleModule } from 'typeorm-timescaledb/nestjs';
import { AppDataSource } from './data-source.js';
import { Reading } from './reading.entity.js';
import { ReadingService } from './reading.service.js';

@Module({
  imports: [
    TimescaleModule.forRoot({ dataSource: AppDataSource }),
    TimescaleModule.forFeature([Reading]),
  ],
  providers: [ReadingService],
})
export class ReadingModule {}
```

For a named context, use the same name in every registration and injection point:

```ts
TimescaleModule.forRoot({
  name: 'analytics',
  dataSource: AnalyticsDataSource,
});

TimescaleModule.forFeature([Reading], 'analytics');
```

## 3. Inject the repository

```ts
import { Injectable } from '@nestjs/common';
import {
  InjectTimescaleRepository,
  TimescaleRepository,
} from 'typeorm-timescaledb/nestjs';
import { Reading } from './reading.entity.js';

@Injectable()
export class ReadingService {
  constructor(
    @InjectTimescaleRepository(Reading)
    private readonly readings: TimescaleRepository<Reading>,
  ) {}

  async recentReadings(sensorId: string) {
    return this.readings.find({
      where: { sensorId },
      order: { time: 'DESC' },
      take: 100,
    });
  }
}
```

For named contexts:

```ts
constructor(
  @InjectTimescaleRepository(Reading, 'analytics')
  private readonly readings: TimescaleRepository<Reading>,
) {}
```

## 4. Use query helpers

```ts
async hourlyAverages(sensorId: string) {
  return this.readings
    .timeBucket({
      timeColumn: 'time',
      interval: '1 hour',
      metrics: {
        avgValue: { column: 'value', aggregate: 'avg' },
      },
    })
    .queryBuilder
    .where('reading.sensorId = :sensorId', { sensorId })
    .getRawMany();
}
```

Use the query-layer guide for the exact helper options available in your package
version.

## 5. Generate and run migrations outside NestJS boot

Do not rely on NestJS application startup to silently mutate production schema.
Generate and run migrations through the CLI or your normal migration pipeline.

For TypeScript DataSource files:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate \
  -d src/data-source.ts \
  -o src/migrations
```

Then review and run the generated migration through your normal process.

## Common mistakes

### Mismatched context names

If `forRoot({ name: 'analytics' })` uses a name, then `forFeature(...)` and
`@InjectTimescaleRepository(...)` must use the same name.

### Registering entities in the wrong DataSource

The DataSource used by the Timescale module must include the same entities that
carry TimescaleDB metadata.

### Treating generated migrations as runtime side effects

Generated migrations are files your team should review and commit. They should
not be hidden inside request handling or application boot.

### Expecting complete auto-diffing

The package does not promise full live configuration reconciliation. Changing
existing TimescaleDB policies, chunk intervals, or dimensions may require manual
migrations.

## Where to go next

- NestJS guide
- API reference
- Production guide
- Troubleshooting guide
- Query layer guide
