import { describe, expect, it } from 'vitest';
import {
  createContinuousAggregateSQL,
  refreshContinuousAggregateSQL,
  TimescaleError,
} from '../src/index.js';

describe('createContinuousAggregateSQL', () => {
  const base = {
    view: 'reading_hourly',
    source: 'reading',
    timeColumn: 'ts',
    bucketInterval: '1 hour',
    aggregates: [
      { fn: 'avg', column: 'value', as: 'avg_v' },
      { fn: 'count', as: 'n' },
    ],
  } as const;

  it('builds a real-time CAGG (materialized_only=false by default), WITH NO DATA', () => {
    const s = createContinuousAggregateSQL(base);
    expect(s.up).toEqual([
      'CREATE MATERIALIZED VIEW "public"."reading_hourly" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS ' +
        `SELECT time_bucket(INTERVAL '1 hour', "ts") AS "bucket", avg("value") AS "avg_v", count(*) AS "n" ` +
        'FROM "public"."reading" GROUP BY "bucket" WITH NO DATA;',
    ]);
  });

  it('down drops the derived view (IF EXISTS); inspect reads the catalog', () => {
    const s = createContinuousAggregateSQL(base);
    expect(s.down).toEqual(['DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly";']);
    expect(s.inspect).toBe(
      'SELECT view_schema, view_name, materialized_only FROM timescaledb_information.continuous_aggregates ' +
        "WHERE view_schema = 'public' AND view_name = 'reading_hourly';",
    );
  });

  it('honours groupBy columns (in SELECT and GROUP BY) and a custom bucket alias', () => {
    const s = createContinuousAggregateSQL({ ...base, groupBy: ['sensor'], bucketAlias: 'hour' });
    expect(s.up[0]).toBe(
      'CREATE MATERIALIZED VIEW "public"."reading_hourly" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS ' +
        `SELECT time_bucket(INTERVAL '1 hour', "ts") AS "hour", "sensor", avg("value") AS "avg_v", count(*) AS "n" ` +
        'FROM "public"."reading" GROUP BY "hour", "sensor" WITH NO DATA;',
    );
  });

  it('emits materialized_only = TRUE when requested', () => {
    const s = createContinuousAggregateSQL({ ...base, materializedOnly: true });
    expect(s.up[0]).toContain('timescaledb.materialized_only = TRUE');
  });

  it('supports schema-qualified view + source', () => {
    const s = createContinuousAggregateSQL({
      ...base,
      view: 'rollups.reading_hourly',
      source: 'ts.reading',
    });
    expect(s.up[0]).toContain('CREATE MATERIALIZED VIEW "rollups"."reading_hourly"');
    expect(s.up[0]).toContain('FROM "ts"."reading"');
    expect(s.inspect).toContain("view_schema = 'rollups'");
  });

  it('rejects an empty aggregate list', () => {
    expect(() => createContinuousAggregateSQL({ ...base, aggregates: [] })).toThrowError(
      TimescaleError,
    );
  });

  it('rejects an unknown aggregate function', () => {
    expect(() =>
      // @ts-expect-error — not an allow-listed fn
      createContinuousAggregateSQL({
        ...base,
        aggregates: [{ fn: 'median', column: 'v', as: 'm' }],
      }),
    ).toThrowError(TimescaleError);
  });

  it('rejects a non-count aggregate without a column', () => {
    expect(() =>
      createContinuousAggregateSQL({ ...base, aggregates: [{ fn: 'avg', as: 'a' }] }),
    ).toThrowError(TimescaleError);
  });

  it('rejects unsafe identifiers (view, source, timeColumn, groupBy, alias, agg column/alias)', () => {
    expect(() => createContinuousAggregateSQL({ ...base, view: 'v);--' })).toThrowError(
      TimescaleError,
    );
    expect(() => createContinuousAggregateSQL({ ...base, source: 's);--' })).toThrowError(
      TimescaleError,
    );
    expect(() => createContinuousAggregateSQL({ ...base, timeColumn: 'ts);--' })).toThrowError(
      TimescaleError,
    );
    expect(() => createContinuousAggregateSQL({ ...base, groupBy: ['s);--'] })).toThrowError(
      TimescaleError,
    );
    expect(() => createContinuousAggregateSQL({ ...base, bucketAlias: 'b);--' })).toThrowError(
      TimescaleError,
    );
    expect(() =>
      createContinuousAggregateSQL({
        ...base,
        aggregates: [{ fn: 'avg', column: 'v);--', as: 'a' }],
      }),
    ).toThrowError(TimescaleError);
    expect(() =>
      createContinuousAggregateSQL({
        ...base,
        aggregates: [{ fn: 'avg', column: 'v', as: 'a);--' }],
      }),
    ).toThrowError(TimescaleError);
  });

  it('rejects a malformed bucket interval', () => {
    expect(() =>
      createContinuousAggregateSQL({ ...base, bucketInterval: '1 fortnight' }),
    ).toThrowError(TimescaleError);
  });
});

describe('refreshContinuousAggregateSQL', () => {
  it('builds a full refresh with NULL bounds', () => {
    expect(refreshContinuousAggregateSQL('reading_hourly', 'NULL', 'NULL')).toBe(
      `CALL refresh_continuous_aggregate('"public"."reading_hourly"', NULL, NULL);`,
    );
  });
  it('builds a bounded refresh with positional placeholders cast to timestamptz', () => {
    expect(refreshContinuousAggregateSQL('reading_hourly', '$1', '$2')).toBe(
      `CALL refresh_continuous_aggregate('"public"."reading_hourly"', $1::timestamptz, $2::timestamptz);`,
    );
  });
  it('casts only placeholder bounds, leaving NULL bounds bare', () => {
    expect(refreshContinuousAggregateSQL('reading_hourly', '$1', 'NULL')).toBe(
      `CALL refresh_continuous_aggregate('"public"."reading_hourly"', $1::timestamptz, NULL);`,
    );
  });
  it('rejects a bound that is neither $N nor NULL', () => {
    expect(() =>
      refreshContinuousAggregateSQL('reading_hourly', "'2024-01-01'", 'NULL'),
    ).toThrowError(TimescaleError);
    expect(() => refreshContinuousAggregateSQL('reading_hourly', '$0', 'NULL')).toThrowError(
      TimescaleError,
    );
  });
});
