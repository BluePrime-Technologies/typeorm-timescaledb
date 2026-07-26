# Query layer guide

`typeorm-timescaledb` 0.2.x introduced the typed query layer on top of the schema
foundation. 0.3.0 extended that layer with typed helpers for the stable
`timescaledb_toolkit` aggregate families implemented in this package. **0.4.0**
completes the continuous-aggregate story (typed decorators, refresh policies,
hierarchical CAGGs, drift detection) and adds downsampling, operational
introspection (informational views + jobs), and T-Digest percentiles. The schema
decorators and migrations still define the TimescaleDB objects; the query layer
helps run common TimescaleDB hyperfunctions through DataSource-scoped
repositories and a DataSource-scoped context.

The query layer follows the same safety rule as the rest of the package: no
prototype mutation and no global TypeORM patching. Query helpers are attached to
the repository wrapper returned by `createTimescale(dataSource).getRepository()`,
or to the `createTimescale(dataSource)` context itself for DataSource-wide
operations (continuous-aggregate refresh, informational views, jobs).

Upgrading across 0.2.x → 0.3.0 → 0.4.0 is additive: existing hypertable metadata
and migrations do not need to change just to use the newer helpers.

## Start from a Timescale repository

```ts
import { createTimescale } from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);
```

The returned repository still behaves like a TypeORM repository, but it also
includes TimescaleDB query helpers such as `getTimeBucket()`,
`timescaleQueryBuilder()`, and toolkit-backed methods. The `ts` context itself
(not the repository) exposes DataSource-wide operations — continuous-aggregate
refresh, informational views, and the jobs API — covered further down.

## Time buckets

Use `getTimeBucket()` when you want the typed, entity-property API. It resolves
entity property names to database column names, validates supported aggregate
names, binds time-range values as parameters, and returns raw rows.

```ts
const rows = await readings.getTimeBucket({
  interval: '1 hour',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  },
  metrics: [
    { alias: 'avgValue', fn: 'avg', column: 'value' },
    { alias: 'lastValue', fn: 'last', column: 'value' },
    { alias: 'count', fn: 'count' },
  ],
});
```

Supported metric functions are `avg`, `sum`, `min`, `max`, `count`, `first`, and
`last`. The default bucket alias is `bucket`.

## Timezone, origin, and offset

`getTimeBucket()` supports the TimescaleDB `time_bucket` variants exposed by the
core builders:

```ts
await readings.getTimeBucket({
  interval: '1 day',
  timezone: 'Europe/London',
  origin: '2026-01-01T00:00:00Z',
  offset: '6 hours',
  metrics: [{ alias: 'avgValue', fn: 'avg', column: 'value' }],
});
```

Without `timezone`, `origin` and `offset` are mutually exclusive. With
`timezone`, both can be supplied because the timezone-aware signature can carry
both positions.

## Gap-filling

Use `gapfill` with `locf` or `interpolate` metric fills when you need a row for
every bucket in a bounded range.

```ts
const rows = await readings.getTimeBucket({
  interval: '1 hour',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-01T06:00:00Z'),
  },
  gapfill: {},
  metrics: [{ alias: 'filledValue', fn: 'avg', column: 'value', fill: 'locf' }],
});
```

Gap-filling requires bounds. Provide either `range.from` and `range.to`, or
`gapfill.start` and `gapfill.finish`. `locf` and `interpolate` fill forward, so
`order: 'DESC'` is rejected for filled gapfill metrics. `interpolate` on a
`count` metric is also rejected because it would produce fractional counts.

## Fluent query builder wrapper

Use `timescaleQueryBuilder()` when you want lower-level control over a TypeORM
`SelectQueryBuilder` while still using TimescaleDB hyperfunction selections.

```ts
const rows = await readings
  .timescaleQueryBuilder('r')
  .timeBucket({ interval: '1 hour', column: 'time' })
  .last('value', 'time', 'lastValue')
  .queryBuilder.where('r."time" >= :from AND r."time" < :to', {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  })
  .getRawMany();
```

This is the raw-identifier tier: column arguments are treated as database column
identifiers and are allow-list validated/quoted. Prefer `getTimeBucket()` when
you want entity property names resolved for you.

### Histogram buckets

`histogram` is exposed on the fluent builder, not as a `getTimeBucket()` metric.
Use it when you want TimescaleDB's `histogram(value, min, max, nbuckets)` array
inside a grouped query.

```ts
import { toNumberArray } from 'typeorm-timescaledb';

const rows = await readings
  .timescaleQueryBuilder('r')
  .timeBucket({ interval: '1 day', column: 'time' })
  .histogram({ column: 'value', min: 0, max: 100, nbuckets: 10 }, 'valueBuckets')
  .queryBuilder.where('r."time" >= :from AND r."time" < :to', {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  })
  .getRawMany();

const bucketCounts = toNumberArray(rows[0]?.valueBuckets, 'valueBuckets');
```

Use `toNumberArray()` for the `int[]` result returned by `histogram`.

When using `timeBucketGapfill()` on the fluent builder, add a matching `WHERE`
range yourself. `start` and `finish` define the output gap range, but do not
filter input rows on their own. The typed `getTimeBucket({ gapfill })` helper
adds those bounds for you.

## Result coercion helpers

Hyperfunction results are raw database values, not hydrated entities. Use the
exported coercion helpers when you need stable JavaScript types:

```ts
import { toDate, toNumber, toBigIntString } from 'typeorm-timescaledb';

const bucket = toDate(row.bucket, 'bucket');
const avgValue = toNumber(row.avgValue, 'avgValue');
const distinctSensors = toBigIntString(row.distinctSensors, 'distinctSensors');
```

Available helpers include `toNumber`, `toNumberOrNull`, `toBigIntString`,
`toDate`, `toNumberArray`, and `mapRawRows`. `toBigIntString()` deliberately
returns a string so large integer-like database values do not lose precision in
JavaScript.

## Continuous aggregates

0.4.0 adds a fully typed continuous-aggregate (CAGG) layer: declare a CAGG as its
own class, decorated with `@ContinuousAggregate`, and pass it to migration
generation alongside your `@Hypertable` entities.

A CAGG class is **not** a TypeORM `@Entity`; it's a pure metadata holder for a
TimescaleDB materialized view. Its columns are the view's output columns.

```ts
import {
  ContinuousAggregate,
  BucketColumn,
  GroupColumn,
  AggregateColumn,
} from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

@ContinuousAggregate({
  name: 'reading_hourly',
  source: Reading,
  bucket: '1 hour',
})
export class ReadingHourly {
  @BucketColumn() bucket!: Date;
  @GroupColumn() sensorId!: string;
  @AggregateColumn({ fn: 'avg', column: 'value' }) avgValue!: number;
  @AggregateColumn({ fn: 'count' }) samples!: number;
}
```

- `@BucketColumn()` marks the property that receives `time_bucket(...)`.
- `@GroupColumn()` marks an extra `GROUP BY` key. Its output name is the
  **source column's physical name** (honoring `@Column({ name })` on the source
  entity), not the CAGG property name — this differs from `@BucketColumn` and
  `@AggregateColumn`, whose output names are the property verbatim.
- `@AggregateColumn({ fn, column })` marks an aggregate output; omit `column`
  only for `fn: 'count'` (→ `count(*)`).

Pass CAGG classes to `generateTimescaleMigration` so their DDL is emitted after
the hypertables they depend on.

> **Note.** The `generate` CLI does **not** emit continuous-aggregate DDL. A CAGG
> is a view, not a TypeORM entity, so it cannot be discovered from the
> DataSource's `entityMetadatas` — the classes have to be passed explicitly,
> which only the programmatic API accepts. Call
> `generateTimescaleMigration(dataSource, { continuousAggregates: [...] })` from
> a small script when your schema includes CAGGs.

```ts
import { generateTimescaleMigration } from 'typeorm-timescaledb';

const migration = generateTimescaleMigration(AppDataSource, {
  continuousAggregates: [ReadingHourly],
});
```

Because a CAGG needs its source hypertable to already exist, `up` always emits
hypertable DDL first, then CAGG DDL; `down` reverses the same order. CAGG
teardown drops the materialized view — this is intentionally **not** reversible
back into a plain view without losing the materialized data, matching the
package's non-destructive `down()` policy elsewhere.

### Real-time aggregation

By default a CAGG is real-time (`timescaledb.materialized_only = false`):
querying it blends materialized data with the latest unmaterialized rows. Set
`materializedOnly: true` to query only the materialized data (faster, but not
current up to the moment).

### Automatic refresh policies

Add `refresh` to have the generated migration wire up
`add_continuous_aggregate_policy` so the CAGG keeps itself up to date on a
schedule:

```ts
@ContinuousAggregate({
  name: 'reading_hourly',
  source: Reading,
  bucket: '1 hour',
  refresh: { startOffset: '3 hours', endOffset: '1 hour', scheduleInterval: '1 hour' },
})
export class ReadingHourly {
  /* ... */
}
```

`scheduleInterval` defaults to the bucket width when omitted.

### Hierarchical continuous aggregates

A CAGG's `source` can be **another `@ContinuousAggregate`**, not just a
hypertable — e.g. a daily rollup built from an hourly CAGG:

```ts
@ContinuousAggregate({ name: 'reading_daily', source: ReadingHourly, bucket: '1 day' })
export class ReadingDaily {
  @BucketColumn() bucket!: Date;
  @GroupColumn() sensorId!: string;
  @AggregateColumn({ fn: 'avg', column: 'avgValue' }) avgValue!: number;
  @AggregateColumn({ fn: 'sum', column: 'samples' }) samples!: number;
}
```

Migration generation topologically orders hierarchical CAGGs so a parent is
created after its child (and dropped before it), and throws on a circular
`source` dependency. There is no dedicated rollup-of-an-average sugar yet
(`@RollupColumn` is planned) — express it today via `@AggregateColumn`, as
above (summing a child's `count` and averaging its `avg` is the standard
rollup-of-averages pattern when bucket sizes are uniform).

### Refreshing a continuous aggregate

Trigger a refresh from application code with the DataSource-scoped context (not
the repository):

```ts
const ts = createTimescale(AppDataSource);
await ts.refreshContinuousAggregate('reading_hourly', {
  start: new Date('2026-01-01T00:00:00Z'),
  end: new Date('2026-01-02T00:00:00Z'),
});
```

`start`/`end` are both optional (omitted → open bound / full refresh). This runs
`refresh_continuous_aggregate` **standalone** — that procedure cannot run inside
a transaction block, so it executes on its own pooled connection rather than
being enrolled in a surrounding `dataSource.transaction(...)` call. Call it
outside a transaction.

### Drift detection

`assertSchema()` can also check that each `@ContinuousAggregate` view exists
and, when `refresh` is set, that its refresh policy is attached — same
`assert`/`warn` mode behavior as hypertable drift checks. **This does not
happen automatically**: pass the CAGG classes via `continuousAggregates`, the
same way you pass them to `generateTimescaleMigration`. With no
`continuousAggregates` passed, `assertSchema()` only checks `@Hypertable`
entities.

```ts
await ts.assertSchema({ continuousAggregates: [ReadingHourly] });
```

## Toolkit-backed helpers

Some methods require the `timescaledb_toolkit` extension. Each toolkit-backed
method checks extension presence once per DataSource and throws
`TimescaleErrorCode.TOOLKIT_MISSING`; the public error string is
`TSDB_TOOLKIT_MISSING`.

0.2.x introduced the first toolkit helpers (`getCandlesticks()` and
`approxCountDistinct()`). 0.3.0 expanded coverage of the stable toolkit aggregate
families implemented in this package, and 0.4.0 adds downsampling and T-Digest
percentiles:

- `getCandlesticks()` — typed OHLCV buckets from `candlestick_agg`.
- `approxCountDistinct()` — approximate distinct count via HyperLogLog, returned
  as a string.
- `getStats()` and `getRegression()` — `stats_agg` summaries and linear
  regression.
- `getPercentiles()` and `getPercentileRanks()` — approximate percentiles via
  `percentile_agg` / UddSketch.
- `getTDigestPercentiles()` and `getTDigestPercentileRanks()` — approximate
  percentiles via a **T-Digest** sketch (`tdigest`), with higher tail accuracy
  than UddSketch.
- `getCounterAgg()` — monotonic counter summaries.
- `getTimeWeight()` — time-weighted average and integral.
- `getStateDurations()`, `getStateTimeline()`, `getStateAt()`, and
  `getStatePeriods()` — state tracking via `state_agg`.
- `getMostCommonValues()` and `getTopN()` — most-common-values via `mcv_agg`.
- `getHeartbeatHealth()`, `getLiveRanges()`, `getDeadRanges()`, and `isLiveAt()`
  — liveness/uptime via `heartbeat_agg`.
- `downsampleLTTB()` and `downsampleASAP()` — visual downsampling via `lttb` and
  `asap_smooth`.

### Candlesticks

```ts
const candles = await readings.getCandlesticks({
  interval: '1 day',
  priceColumn: 'price',
  volumeColumn: 'volume',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  },
});
```

Key options are `interval`, `priceColumn`, `volumeColumn`, optional `timeColumn`,
optional `range`, and optional `order`. `vwap` is `number | null` because
TimescaleDB returns `NULL` when a bucket's total volume is zero.

### Statistics and regression

```ts
const stats = await readings.getStats({
  valueColumn: 'value',
  method: 'sample',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  },
});

const regression = await readings.getRegression({
  yColumn: 'value',
  xColumn: 'temperature',
  method: 'population',
});
```

`getStats()` uses `valueColumn`, optional `method`, optional `range`, and optional
`timeColumn`. `getRegression()` uses `yColumn`, `xColumn`, optional `method`,
optional `range`, and optional `timeColumn`. Both return `null` when the input set
is empty.

### Percentiles

```ts
const percentiles = await readings.getPercentiles({
  valueColumn: 'value',
  percentiles: [0.5, 0.95, 0.99],
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  },
});
```

Key options are `valueColumn`, `percentiles`, optional `range`, and optional
`timeColumn`. Percentile values must be finite numbers between `0` and `1`.
Use `getPercentileRanks()` when you need ranks for specific values instead of
percentile values.

### T-Digest percentiles

`getTDigestPercentiles()` and `getTDigestPercentileRanks()` mirror the
`percentile_agg`-based helpers above, but sketch with `tdigest` instead of
UddSketch:

```ts
const percentiles = await readings.getTDigestPercentiles({
  valueColumn: 'value',
  percentiles: [0.5, 0.95, 0.99],
  buckets: 200, // optional sketch size; default 100
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  },
});
```

T-Digest trades some accuracy in the middle of the distribution for better
accuracy at the tails (e.g. p99/p999), so prefer it over `getPercentiles()` when
tail latency/values matter most. The result also includes `mean`, `min`, and
`max` alongside the requested percentiles. `buckets` controls sketch size
(accuracy vs. memory); default `100`.

### State tracking

```ts
const durations = await readings.getStateDurations({
  valueColumn: 'status',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  },
});

const currentState = await readings.getStateAt({
  valueColumn: 'status',
  at: new Date('2026-01-01T12:00:00Z'),
});
```

State-tracking helpers use a text `valueColumn`, optional `range`, and optional
`timeColumn`. `getStateAt()` also accepts `at`; `getStatePeriods()` accepts a
specific `state` to filter periods.

### Downsampling

`downsampleLTTB()` and `downsampleASAP()` reduce a series to a target number of
`{ time, value }` points, for charting large ranges without shipping every raw
point to the client:

```ts
const points = await readings.downsampleLTTB({
  valueColumn: 'value',
  resolution: 500,
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-02-01T00:00:00Z'),
  },
});
```

- **LTTB** (Largest-Triangle-Three-Buckets) picks the `resolution` points that
  best preserve the series' visual shape — good for line charts where you want
  the silhouette to look right.
- **ASAP** smooths the series to `resolution` points, minimizing visual noise
  while preserving large-scale trends — good when the raw series is noisy and
  you want a clean trend line.

`resolution` must be an integer between 3 and 1,000,000 (the toolkit's own
floor for `lttb` is 3; there is no such floor for `asap_smooth`, but the two
share one option shape here). Both return `[]` for an empty (filtered) input.

## Operational introspection: informational views and jobs

0.4.0 adds typed, read-only access to `timescaledb_information.*` and the jobs
API, exposed on the **DataSource-scoped context** (`createTimescale(dataSource)`),
not on a per-entity repository — these are DataSource-wide, not entity-scoped.

```ts
const ts = createTimescale(AppDataSource);

const hypertables = await ts.listHypertables();
const chunks = await ts.listChunks({ hypertable: 'reading' });
const caggs = await ts.listContinuousAggregates();
const jobs = await ts.listJobs({ hypertable: 'reading' });
const stats = await ts.getJobStats(jobs[0]!.jobId);
```

- `listHypertables()` — every hypertable, with dimension/chunk counts and
  whether columnstore is enabled.
- `listChunks(options?)` — chunks, optionally filtered to one hypertable
  (`options.hypertable`, bare name or `schema.name`); includes each chunk's
  range and compression state.
- `listContinuousAggregates()` — every CAGG, with its materialized-only and
  compression state.
- `listJobs(options?)` — background jobs (policies you configured, plus any
  user-defined action jobs), optionally filtered to one hypertable/CAGG.
- `getJobStats(jobId)` — one job's run history (last run, successes/failures,
  next scheduled start), or `null` if the id is unknown.

### Running and managing jobs

```ts
await ts.runJob(jobs[0]!.jobId); // run a job now, outside its schedule

const jobId = await ts.addJob('my_schema.my_action_proc', {
  scheduleInterval: '1 hour',
  config: { threshold: 100 },
});

await ts.alterJob(jobId, { scheduleInterval: '30 minutes' });
await ts.deleteJob(jobId);
```

- `runJob(jobId)` — runs a background job immediately via `run_job`. Executes
  standalone (autocommit): a job's action may not run inside a transaction, so
  this is not enrolled in a surrounding `dataSource.transaction(...)` call —
  same rule as `refreshContinuousAggregate()`.
- `addJob(proc, options)` — registers a **user-defined action job** running an
  existing stored procedure `(job_id int, config jsonb)`. Schema-qualify `proc`
  (`my_schema.my_proc`) to avoid relying on `search_path`. Returns the new job
  id.
- `alterJob(jobId, changes)` — changes an existing job. Only the fields you set
  are sent; anything omitted is left unchanged. If you set `config`, it
  **replaces** the whole config — it is not merged with the existing one.
- `deleteJob(jobId)` — deletes a job.

All of the above run on a pooled connection outside any surrounding transaction,
matching `refreshContinuousAggregate()`'s standalone-execution rule.

## What remains future scope

The query layer does not make this package a complete TimescaleDB abstraction.
`@RollupColumn` ergonomic sugar for hierarchical CAGG rollups (expressible today
via `@AggregateColumn`, see above), validated cross-store references, a full
safe diff engine, experimental toolkit aggregates such as `gauge_agg`,
`freq_agg`, and `compact_state_agg`, and stable Toolkit aggregates not listed
above remain future scope.
