# Quickstart

This quickstart shows the shortest path from a TypeORM entity to a TimescaleDB migration.

## 1. Define an entity

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

## 2. Let TypeORM create the base table

`typeorm-timescaledb` adds the TimescaleDB layer. Your TypeORM setup still owns the base `CREATE TABLE` step through `synchronize` or a TypeORM migration.

## 3. Generate the TimescaleDB migration

```sh
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations
```

## 4. Apply the migration

```sh
npx typeorm-timescaledb run -d src/data-source.ts
```

## 5. Use the runtime context

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(dataSource);
const readings = ts.getRepository(Reading);
await ts.assertSchema();
```

## Next

Step 4 will expand this into a full 10-minute tutorial with a local TimescaleDB setup, commands, expected output, insert/query steps, and drift verification.
