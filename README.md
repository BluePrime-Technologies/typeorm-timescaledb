# typeorm-timescaledb

> A pre-1.0, multi-DataSource-safe [TimescaleDB](https://www.tigerdata.com/) integration for [TypeORM](https://typeorm.io/) — define hypertables, columnstore, and retention as typed entities, and generate/apply reviewable migrations for them.

**The vision:** every TimescaleDB capability expressed through typed ORM constructs, so you never hand-write TimescaleDB SQL. **0.2.x** introduced the query layer (time buckets, gap-filling, candlesticks); **0.3.0** expanded the stable `timescaledb_toolkit` aggregate coverage; **0.4.0** completes continuous aggregates (typed decorators, refresh policies, hierarchical, drift) and adds downsampling, informational views + jobs, and T-Digest percentiles; **0.5.0** adds async/deferred NestJS configuration (`forRootAsync`) and a fail-fast TimescaleDB-presence check; **0.6.0** ships the **migration engine** — it reads your live database, diffs it against your entities, and converges it, with every step safety-classified.

## Status and scope

`typeorm-timescaledb` is an actively maintained **pre-1.0** package for TypeORM users who want typed TimescaleDB hypertables, columnstore, retention, reviewable migrations, DataSource-scoped repositories, drift detection, NestJS integration, a typed hyperfunction query layer, and stable toolkit aggregate helpers.

It is **not** a complete TimescaleDB abstraction yet. Experimental (non-stable) toolkit aggregates and structural diffing of continuous aggregates are planned but not shipped. (Continuous aggregates and stable Toolkit aggregates including T-Digest shipped in 0.4.0; the migration engine shipped in 0.6.0 — see below.)

**What the engine does and does not change for you:** it auto-diffs compression/retention thresholds, the chunk interval, the columnstore segment-by/order-by configuration, and renames — and, only when you opt in, removes a retention or compression policy (reversibly). It never emits a destructive change: dropping a hypertable or disabling a columnstore is always yours to write by hand, and a space-dimension divergence is reported as an error rather than silently ignored. The base `CREATE TABLE` remains TypeORM's responsibility; this package adds the TimescaleDB layer on top.

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

# emit raw SQL instead of a TypeORM migration class:
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations --output sql

# CI drift gate: prints what would change and exits non-zero if the DB has drifted
npx typeorm-timescaledb check -d src/data-source.ts

# converge the database to your entities — PREVIEWS by default, applies nothing:
npx typeorm-timescaledb push -d src/data-source.ts
# ...and actually run it:
npx typeorm-timescaledb push -d src/data-source.ts --apply
```

`push` exits **0** when the database already matches (or after converging it) and **2** when it
found drift and deliberately did not touch anything — so a script can tell "there is drift" apart
from "the command failed" (**1**). Two further opt-ins, kept separate on purpose because they are
different risks: `--allow-drops` also applies the reversible policy _removals_ the diff can emit,
and `--allow-refused` also applies steps classified `refuse-by-default`.

> **TypeScript DataSource?** The CLI uses native `import()`, so a `.ts` `-d` file needs a TypeScript loader. Run it under [`tsx`](https://tsx.is) (`npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations`) or [`ts-node`](https://typestrong.org/ts-node/) (`node --import ts-node/esm`), or point `-d` at a compiled `.js` DataSource.

Get a typed, hypertable-aware repository — scoped to your DataSource, no globals:

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(dataSource);
const readings = ts.getRepository(Reading);
await ts.assertSchema(); // fail fast if the live DB drifted from your entities
```

### Keeping the database in step with your entities

`check` is the one-liner for CI. Programmatically, the same engine is three calls — read, diff,
apply — and every step tells you how risky it is before you run it:

`pushSchema()` is the one-call form of the three-call example below — same preview-by-default
semantics, same gates:

```ts
import { pushSchema } from 'typeorm-timescaledb';

const { plan, applied } = await pushSchema(dataSource); // preview: writes nothing
await pushSchema(dataSource, { apply: true }); // converge
```

Or drive the steps yourself when you want to inspect or filter the plan first:

```ts
import { introspect, compileDesiredState, applyDirect } from 'typeorm-timescaledb';
import { diffSchemaState, isEmptyPlan } from '@blueprime/timescaledb-core';

const plan = diffSchemaState(await introspect(dataSource), compileDesiredState(dataSource));

if (!isEmptyPlan(plan)) {
  for (const step of plan.steps) {
    console.log(`[${step.safety}] ${step.operation.kind} — ${step.reason}`);
  }
  // Refuses anything classified `refuse-by-default` unless you opt in; runs in one transaction.
  await applyDirect(dataSource, plan);
}
```

Prefer a reviewable artifact? Turn the same plan into a committable migration with
`planToMigration(plan)`, or hand-author one with the fluent builder:

```ts
import { TimescaleSchemaBuilder } from 'typeorm-timescaledb';

export class AddRetention1700000000000 implements MigrationInterface {
  private readonly schema = new TimescaleSchemaBuilder().addRetentionPolicy({
    table: 'reading',
    dropAfter: '90 days',
  });

  up = (qr: QueryRunner) => this.schema.up(qr);
  down = (qr: QueryRunner) => this.schema.down(qr); // reversible, never destructive
}
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

## What's in 0.6.x

**Works today (0.6.x):**

- **Migration engine** — read the live database, diff it against your entities, converge it:
  - `introspect(dataSource)` → a canonical `SchemaStateIR` of what the database actually has.
  - `diffSchemaState(current, desired, opts?)` → an ordered `Plan`, each step carrying a **safety
    class** (`online-safe` · `needs-recompress` · `refuse-by-default` · `one-way`) and a reason.
  - **`check` CLI verb** → readable drift preview, non-zero exit on drift (a CI schema gate).
  - `@Hypertable({ renamedFrom })` → a rename resolves to one `ALTER TABLE ... RENAME`, not a
    drop-then-create.
  - **Opt-in guarded drops** (`allowDrops`) → removes a retention/compression policy present in the
    database but absent from your entities. Reversible; destructive drops are never emitted.
  - **Emitters** → `generate --output <ts|sql>`, `planToMigration(plan)`, `compilePlan(plan)`.
  - **`TimescaleSchemaBuilder`** → a fluent hand-authoring surface that runs inside an ordinary
    TypeORM migration via `queryRunner`, producing SQL byte-identical to the generated path.
  - **`applyDirect(dataSource, plan, opts?)`** → apply a plan straight to a live database in one
    transaction, refusing `refuse-by-default` operations unless you explicitly opt in.

- `@Hypertable` / `@TimeColumn` / `@HypertablePrimaryKey` — hypertables with chunk interval, **columnstore** (segmentby/orderby + policy), **retention** policy, and **space (hash) partitioning**.
- **Migration generation + CLI** (`generate | run | revert | status`) — reviewable, reversible migrations; generated `down()` methods are **never destructive**.
- **Per-DataSource repositories** (`createTimescale`) and **boot-time drift detection** (`assertSchema`), which **fails fast** (`TSDB_TIMESCALEDB_MISSING`) when the `timescaledb` extension isn't installed.
- **Base typed query layer** — `repo.getTimeBucket(...)` and a fluent `repo.timescaleQueryBuilder()` covering `time_bucket` (timezone/origin/offset), `first`/`last`, `histogram`, and the gap-filling family (`time_bucket_gapfill` + `locf` / `interpolate`). Results come back through typed coercion helpers.
- **Stable `timescaledb_toolkit` aggregate helpers** — `repo.getCandlesticks(...)`, `repo.approxCountDistinct(...)`, `repo.getStats(...)`, `repo.getRegression(...)`, `repo.getPercentiles(...)`, `repo.getPercentileRanks(...)`, `repo.getCounterAgg(...)`, `repo.getTimeWeight(...)`, `repo.getStateDurations(...)`, `repo.getStateTimeline(...)`, `repo.getStateAt(...)`, `repo.getStatePeriods(...)`, `repo.getMostCommonValues(...)`, `repo.getTopN(...)`, `repo.getHeartbeatHealth(...)`, `repo.getLiveRanges(...)`, `repo.getDeadRanges(...)`, and `repo.isLiveAt(...)`, all with a presence check that fails fast (`TSDB_TOOLKIT_MISSING`) when the extension is not installed.
- **Continuous aggregates** — `@ContinuousAggregate` / `@BucketColumn` / `@GroupColumn` / `@AggregateColumn` decorators with migration codegen, **automatic refresh policies** (`@ContinuousAggregate({ refresh })`), **hierarchical** CAGGs (a CAGG whose `source` is another CAGG), runtime `refreshContinuousAggregate(...)`, and **drift detection** for CAGGs + policies via `assertSchema()`.
- **Downsampling** — `repo.downsampleLTTB(...)` / `repo.downsampleASAP(...)` (toolkit `lttb` / `asap_smooth`), typed `{ time, value }[]`.
- **Informational views + jobs** — `createTimescale(ds).listHypertables(...)`, `listChunks(...)`, `listContinuousAggregates(...)`, `listJobs(...)`, `getJobStats(...)`, `runJob(...)`, and the action jobs API `addJob(...)` / `alterJob(...)` / `deleteJob(...)`.
- **T-Digest percentiles** — `repo.getTDigestPercentiles(...)` / `repo.getTDigestPercentileRanks(...)` (toolkit `tdigest`).
- **NestJS module** with optional-peer wiring, named multi-DataSource contexts, and **async/deferred configuration** (`TimescaleModule.forRootAsync` — `useFactory` + `inject` + `imports`, with an optional no-op mode).
- Unified import surface (one package, never raw `typeorm`); dual ESM + CJS.

## 0.6.0 release scope

The 0.6.0 release ships the **unified migration engine** (listed under **Works today** above):
introspection, a safety-classified diff, the `check` drift gate, rename resolution, opt-in guarded
drops, the SQL/TS emitters, the fluent schema builder, and guarded direct apply. It also lands a
full-library correctness audit — 40 findings resolved, including an output-alias SQL-injection
reachable on TypeORM 0.3.x, a cross-schema data leak in `listChunks`/`listJobs`, and a
hierarchical-CAGG migration that failed outright when the source column was `@Column({ name })`-remapped.
See the [CHANGELOG](./CHANGELOG.md) for the full list. No breaking API changes.

**Known limitations in 0.6.0:** continuous aggregates are not structurally diffed (the diff is
hypertable-scoped, so `check` does not cover CAGG drift); space (hash) dimensions cannot be
reconciled in place — a divergence is reported as an error naming the required manual migration;
and the one-command `push` / `pull` / `sync` verbs are not in this release (use `check` plus
`generate`, or the programmatic API).

## 0.5.0 release scope

The 0.5.0 release adds **`TimescaleModule.forRootAsync`** (deferred/async DataSource
configuration for NestJS) and a **fail-fast TimescaleDB-presence check** in `assertSchema()`
(`TSDB_TIMESCALEDB_MISSING`), plus a correctness/hardening pass across the core SQL builders
(interval whitespace, safe-integer bounds, `orderBy`/identifier validation) and the TypeORM
result mapper and CLI DataSource loader. No breaking API changes. It builds on the 0.4.0
continuous-aggregate, downsampling, introspection, and T-Digest work below.

## 0.4.0 release scope

The 0.4.0 release completes the continuous-aggregate story and adds downsampling,
operational introspection, and T-Digest percentiles (all listed under **Works today**
above). It builds on the 0.3.0 toolkit-aggregate helpers (stats/regression, UddSketch
percentiles, counters, time-weight, state tracking, MCV/top-N, heartbeat/liveness).

**Migration model (important):** `generate` emits an **additive / desired-state** migration — the full hypertable setup, idempotently (`if_not_exists`). Separately, the **migration engine** (`check`, `introspect` + `diffSchemaState`, `applyDirect`) reconciles a live database against your entities and _does_ auto-diff altered configuration: compression/retention thresholds, the chunk interval, the columnstore segment-by/order-by, and renames — plus, behind `allowDrops`, reversible policy removals. What still needs a hand-written migration: dropping a hypertable or disabling a columnstore (never auto-generated), adding/removing/re-partitioning a space dimension, and structural changes to continuous aggregates. (The base `CREATE TABLE` is TypeORM's job — via `synchronize` or its own migration; this package adds the TimescaleDB layer on top.)

**Not yet (planned):** `@RollupColumn` sugar for hierarchical rollups (expressible today via `@AggregateColumn`), the still-`toolkit_experimental` aggregates (`gauge_agg`/`freq_agg`/`compact_state_agg`), stable Toolkit aggregates not listed above, structural diffing of continuous aggregates, in-place reconciliation of space dimensions, and the one-command `push`/`pull`/`sync` verbs. **Unsupported by design:** automatic destructive migrations — dropping a hypertable or disabling a columnstore is never generated for you.

## Design principles

1. **Multi-DataSource safe** — no prototype patching, no global singletons; per-DataSource factories only.
2. **Migration-driven DDL** — never `synchronize: true` for TimescaleDB objects; generated rollbacks never destroy data.
3. **Tested against real TimescaleDB** — integration + deep E2E tests run against a real container and assert against `timescaledb_information.*`, not SQL strings.

## Packages

| Package                       | Description                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `typeorm-timescaledb`         | The TypeORM integration: decorators, repository, migrations, CLI, NestJS module.                       |
| `@blueprime/timescaledb-core` | ORM-agnostic SQL/DDL generation, the operation IR, the diff/plan engine, identifier safety.            |
| `@blueprime/cross-store`      | Validated cross-**database** `@Resolve` references (separate opt-in package, versioned independently). |

## License

Apache-2.0 © BluePrime Technologies. Maintained by Miracle Adebunmi ([@madebunmi-prime](https://github.com/madebunmi-prime)). See [MAINTAINERS.md](./MAINTAINERS.md).
