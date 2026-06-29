# Query layer guide

`typeorm-timescaledb` 0.2.x adds a typed query layer on top of the schema
foundation. The schema decorators and migrations still define the TimescaleDB
objects; the query layer helps run common TimescaleDB hyperfunctions through
DataSource-scoped repositories.

The query layer follows the same safety rule as the rest of the package: no
prototype mutation and no global TypeORM patching. Query helpers are attached to
the repository wrapper returned by `createTimescale(dataSource).getRepository()`.

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
`timescaleQueryBuilder()`, and toolkit-backed methods.

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

Supported metric functions are:

- `avg`
- `sum`
- `min`
- `max`
- `count`
- `first`
- `last`

The default bucket alias is `bucket`. Use `bucketAlias` when you need a different
raw result key.

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

Available helpers include:

- `toNumber`
- `toNumberOrNull`
- `toBigIntString`
- `toDate`
- `toNumberArray`
- `mapRawRows`

`toBigIntString()` deliberately returns a string so large integer-like database
values do not lose precision in JavaScript.

## Toolkit-backed helpers

Some methods require the `timescaledb_toolkit` extension. Each toolkit-backed
method checks extension presence once per DataSource and throws the stable
`TSDB_TOOLKIT_MISSING` error if the extension is absent.

Toolkit-backed methods on `TimescaleRepository` include:

- `getCandlesticks()` — typed OHLCV buckets from `candlestick_agg`.
- `approxCountDistinct()` — approximate distinct count via HyperLogLog, returned
  as a string.
- `getStats()` and `getRegression()` — `stats_agg` summaries and linear
  regression.
- `getPercentiles()` and `getPercentileRanks()` — approximate percentiles via
  `percentile_agg` / uddsketch.
- `getCounterAgg()` — monotonic counter summaries.
- `getTimeWeight()` — time-weighted average and integral.
- `getStateDurations()`, `getStateTimeline()`, `getStateAt()`, and
  `getStatePeriods()` — state tracking via `state_agg`.
- `getMostCommonValues()` and `getTopN()` — most-common-values via `mcv_agg`.
- `getHeartbeatHealth()`, `getLiveRanges()`, `getDeadRanges()`, and `isLiveAt()`
  — liveness/uptime via `heartbeat_agg`.

Example candlestick query:

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

`vwap` is `number | null` because TimescaleDB returns `NULL` when a bucket's total
volume is zero.

## What remains future scope

The query layer does not make this package a complete TimescaleDB abstraction.
Continuous aggregates, validated cross-store references, a full safe diff engine,
and experimental toolkit aggregates such as `gauge_agg`, `freq_agg`, and
`compact_state_agg` remain future scope.
