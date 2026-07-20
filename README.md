# typeorm-timescaledb

> A pre-1.0, multi-DataSource-safe [TimescaleDB](https://www.tigerdata.com/) integration for [TypeORM](https://typeorm.io/) — define hypertables, columnstore, and retention as typed entities, and generate/apply reviewable migrations for them.

**The vision:** every TimescaleDB capability expressed through typed ORM constructs, so you never hand-write TimescaleDB SQL. **0.2.x** introduced the query layer (time buckets, gap-filling, candlesticks); **0.3.0** expanded the stable `timescaledb_toolkit` aggregate coverage; **0.4.0** completes continuous aggregates (typed decorators, refresh policies, hierarchical, drift) and adds downsampling, informational views + jobs, and T-Digest percentiles. Cross-store references and a full safe diff engine come later.

## Status and scope

`typeorm-timescaledb` is an actively maintained **pre-1.0** package for TypeORM users who want typed TimescaleDB hypertables, columnstore, retention, reviewable migrations, DataSource-scoped repositories, drift detection, NestJS integration, a typed hyperfunction query layer, and stable toolkit aggregate helpers.

It is **not** a complete TimescaleDB abstraction yet. Validated cross-store references, experimental (non-stable) toolkit aggregates, and a full entity-to-database diff engine are planned but not shipped. (Continuous aggregates and stable Toolkit aggregates including T-Digest shipped in 0.4.0 — see below.) Removing or altering existing TimescaleDB configuration still requires a hand-written migration. The base `CREATE TABLE` remains TypeORM's responsibility; this package adds the TimescaleDB layer on top.

## Why this exists

Modeling TimescaleDB in TypeScript should be as simple as modeling any other table. Today, getting hypertables, columnstore, and retention into a TypeORM project means dropping into raw SQL and hand-managing migrations. `typeorm-timescaledb` closes that gap: you express supported TimescaleDB features as typed ORM constructs on your entities, the package generates and applies the migrations for those features, and a typed query layer runs the hyperfunctions for you — so working with time-series in TypeORM feels native, minimal, and obvious.

It's built on one hard rule:

> **No global mutation. Ever.** Everything is scoped to the `DataSource` you pass in — so an app can safely run multiple DataSources side by side (e.g. a NestJS "Postgres + TimescaleDB" setup). Enforced by a CI gate that boots two DataSources and asserts the plain one is untouched.

## Install

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Ships **dual ESM + CJS** with full type definitions. Requires **TimescaleDB ≥ 2.18**, TypeORM `^0.3.20 || ^1.0.0`, Node `^20.19.0 || >=22.12.0`.

## Quick start

Define your schema with one import — entities, columns, relations, and the TimescaleDB extensions all come from `typeorm-timescaledb` (you never reach for raw `typeorm`):

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

Generate and run a migration with the CLI (point `-d` at your DataSource module):

```sh
# 1. your DataSource/TypeORM creates the plain table (synchronize or a TypeORM migration)
# 2. generate the TimescaleDB migration from your @Hypertable entities:
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations
# 3. apply it (also: revert | status):
npx typeorm-timescaledb run -d src/data-source.ts
```

> **TypeScript DataSource?** The CLI uses native `import()`, so a `.ts` `-d` file needs a TypeScript loader. Run it under [`tsx`](https://tsx.is) (`npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations`) or [`ts-node`](https://typestrong.org/ts-node/) (`node --import ts-node/esm`), or point `-d` at a compiled `.js` DataSource.

Get a typed, hypertable-aware repository — scoped to your DataSource, no globals:

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(dataSource);
const readings = ts.getRepository(Reading);
await ts.assertSchema(); // fail fast if the live DB drifted from your entities
```

### NestJS

```ts
import { TimescaleModule, InjectTimescaleRepository } from 'typeorm-timescaledb/nestjs';

@Module({
  imports: [
    TimescaleModule.forRoot({ dataSource, assert: 'assert' }), // boot-time drift check
    TimescaleModule.forFeature([Reading]),
  ],
})
export class AppModule {}
```

Multiple TimescaleDB DataSources? Pass a `name` to `forRoot` / `forFeature` / `@InjectTimescaleRepository`.

Need the `DataSource` resolved asynchronously (e.g. from `ConfigService`)? Use `forRootAsync`:

```ts
TimescaleModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    dataSource: buildDataSource(config),
    assert: 'warn',
  }),
});
```

Return `undefined` from `useFactory` to register a no-op context (no `DataSource`, no
boot-time drift check) for environments where TimescaleDB isn't configured — mark any
`@InjectTimescaleContext()` / `@InjectTimescaleRepository()` consumer `@Optional()` in that case.

## What's in 0.4.x

**Works today (0.4.x):**

- `@Hypertable` / `@TimeColumn` / `@HypertablePrimaryKey` — hypertables with chunk interval, **columnstore** (segmentby/orderby + policy), **retention** policy, and **space (hash) partitioning**.
- **Migration generation + CLI** (`generate | run | revert | status`) — reviewable, reversible migrations; generated `down()` methods are **never destructive**.
- **Per-DataSource repositories** (`createTimescale`) and **boot-time drift detection** (`assertSchema`).
- **Base typed query layer** — `repo.getTimeBucket(...)` and a fluent `repo.timescaleQueryBuilder()` covering `time_bucket` (timezone/origin/offset), `first`/`last`, `histogram`, and the gap-filling family (`time_bucket_gapfill` + `locf` / `interpolate`). Results come back through typed coercion helpers.
- **Stable `timescaledb_toolkit` aggregate helpers** — `repo.getCandlesticks(...)`, `repo.approxCountDistinct(...)`, `repo.getStats(...)`, `repo.getRegression(...)`, `repo.getPercentiles(...)`, `repo.getPercentileRanks(...)`, `repo.getCounterAgg(...)`, `repo.getTimeWeight(...)`, `repo.getStateDurations(...)`, `repo.getStateTimeline(...)`, `repo.getStateAt(...)`, `repo.getStatePeriods(...)`, `repo.getMostCommonValues(...)`, `repo.getTopN(...)`, `repo.getHeartbeatHealth(...)`, `repo.getLiveRanges(...)`, `repo.getDeadRanges(...)`, and `repo.isLiveAt(...)`, all with a presence check that fails fast (`TSDB_TOOLKIT_MISSING`) when the extension is not installed.
- **Continuous aggregates** — `@ContinuousAggregate` / `@BucketColumn` / `@GroupColumn` / `@AggregateColumn` decorators with migration codegen, **automatic refresh policies** (`@ContinuousAggregate({ refresh })`), **hierarchical** CAGGs (a CAGG whose `source` is another CAGG), runtime `refreshContinuousAggregate(...)`, and **drift detection** for CAGGs + policies via `assertSchema()`.
- **Downsampling** — `repo.downsampleLTTB(...)` / `repo.downsampleASAP(...)` (toolkit `lttb` / `asap_smooth`), typed `{ time, value }[]`.
- **Informational views + jobs** — `createTimescale(ds).listHypertables(...)`, `listChunks(...)`, `listContinuousAggregates(...)`, `listJobs(...)`, `getJobStats(...)`, `runJob(...)`, and the action jobs API `addJob(...)` / `alterJob(...)` / `deleteJob(...)`.
- **T-Digest percentiles** — `repo.getTDigestPercentiles(...)` / `repo.getTDigestPercentileRanks(...)` (toolkit `tdigest`).
- **NestJS module** with optional-peer wiring and named multi-DataSource contexts.
- Unified import surface (one package, never raw `typeorm`); dual ESM + CJS.

## 0.4.0 release scope

The 0.4.0 release completes the continuous-aggregate story and adds downsampling,
operational introspection, and T-Digest percentiles (all listed under **Works today**
above). It builds on the 0.3.0 toolkit-aggregate helpers (stats/regression, UddSketch
percentiles, counters, time-weight, state tracking, MCV/top-N, heartbeat/liveness).

**Migration model (important):** generated migrations are **additive / desired-state** — they emit the full hypertable setup idempotently (`if_not_exists`). Adding supported configuration (a new entity, a new policy) propagates on the next `generate` + `run`. **Removing or altering** existing config (e.g. dropping a retention policy, changing a chunk interval) is **not** auto-diffed yet — do those in a hand-written migration for now. A full entity↔DB diff engine is planned. (The base `CREATE TABLE` is TypeORM's job — via `synchronize` or its own migration; this package adds the TimescaleDB layer on top.)

**Not yet (planned):** `@RollupColumn` sugar for hierarchical rollups (expressible today via `@AggregateColumn`), the still-`toolkit_experimental` aggregates (`gauge_agg`/`freq_agg`/`compact_state_agg`), stable Toolkit aggregates not listed above, the full diff engine, and validated cross-store references. **Unsupported by design:** automatic destructive/altering migrations.

## Design principles

1. **Multi-DataSource safe** — no prototype patching, no global singletons; per-DataSource factories only.
2. **Migration-driven DDL** — never `synchronize: true` for TimescaleDB objects; generated rollbacks never destroy data.
3. **Tested against real TimescaleDB** — integration + deep E2E tests run against a real container and assert against `timescaledb_information.*`, not SQL strings.

## Packages

| Package                       | Description                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `typeorm-timescaledb`         | The TypeORM integration: decorators, repository, migrations, CLI, NestJS module. |
| `@blueprime/timescaledb-core` | ORM-agnostic SQL/DDL generation, metadata model, identifier safety.              |

## License

Apache-2.0 © BluePrime Technologies. Maintained by Miracle Adebunmi ([@madebunmi-prime](https://github.com/madebunmi-prime)). See [MAINTAINERS.md](./MAINTAINERS.md).
