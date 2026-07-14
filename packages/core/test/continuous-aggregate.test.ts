import { describe, expect, it } from 'vitest';
import {
  createContinuousAggregateSQL,
  refreshContinuousAggregateSQL,
  addContinuousAggregatePolicySQL,
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
        `FROM "public"."reading" GROUP BY time_bucket(INTERVAL '1 hour', "ts") WITH NO DATA;`,
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
        `FROM "public"."reading" GROUP BY time_bucket(INTERVAL '1 hour', "ts"), "sensor" WITH NO DATA;`,
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

describe('addContinuousAggregatePolicySQL', () => {
  it('builds add/remove with interval offsets + schedule, always if_not_exists', () => {
    const stmt = addContinuousAggregatePolicySQL({
      view: 'reading_hourly',
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '30 minutes',
    });
    expect(stmt.up).toEqual([
      `SELECT add_continuous_aggregate_policy('"public"."reading_hourly"', ` +
        `start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', ` +
        `schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);`,
    ]);
    expect(stmt.down).toEqual([
      `SELECT remove_continuous_aggregate_policy('"public"."reading_hourly"', if_exists => TRUE);`,
    ]);
  });

  it('emits NULL for open (null) offsets', () => {
    const stmt = addContinuousAggregatePolicySQL({
      view: 'reading_hourly',
      startOffset: null,
      endOffset: null,
      scheduleInterval: '1 hour',
    });
    expect(stmt.up[0]).toContain('start_offset => NULL, end_offset => NULL');
  });

  it('omits schedule_interval when not provided (server default)', () => {
    const stmt = addContinuousAggregatePolicySQL({
      view: 'reading_hourly',
      startOffset: '7 days',
      endOffset: '1 hour',
    });
    expect(stmt.up[0]).not.toContain('schedule_interval');
    expect(stmt.up[0]).toContain("end_offset => INTERVAL '1 hour', if_not_exists => TRUE");
  });

  it('honours a schema-qualified view in add, remove, and inspect', () => {
    const stmt = addContinuousAggregatePolicySQL({
      view: 'analytics.reading_hourly',
      startOffset: '1 month',
      endOffset: '1 hour',
    });
    expect(stmt.up[0]).toContain(`add_continuous_aggregate_policy('"analytics"."reading_hourly"'`);
    expect(stmt.down[0]).toContain(
      `remove_continuous_aggregate_policy('"analytics"."reading_hourly"'`,
    );
    // inspect matches the view either directly or via its materialization hypertable
    expect(stmt.inspect).toContain("proc_name = 'policy_refresh_continuous_aggregate'");
    expect(stmt.inspect).toContain(`view_schema = 'analytics'`);
    expect(stmt.inspect).toContain(`view_name = 'reading_hourly'`);
  });

  it('rejects a non-positive / invalid interval offset', () => {
    expect(() =>
      addContinuousAggregatePolicySQL({
        view: 'reading_hourly',
        startOffset: 'not-an-interval',
        endOffset: '1 hour',
      }),
    ).toThrowError(TimescaleError);
    expect(() =>
      addContinuousAggregatePolicySQL({
        view: 'reading_hourly',
        startOffset: '1 month',
        endOffset: '1 hour',
        scheduleInterval: 'nope',
      }),
    ).toThrowError(TimescaleError);
  });

  it('rejects an unsafe view identifier (injection guard)', () => {
    expect(() =>
      addContinuousAggregatePolicySQL({
        view: 'v);--',
        startOffset: '1 month',
        endOffset: '1 hour',
      }),
    ).toThrowError(TimescaleError);
    // zero-magnitude interval is rejected (a zero-width refresh window is a no-op)
    expect(() =>
      addContinuousAggregatePolicySQL({
        view: 'reading_hourly',
        startOffset: '0 hour',
        endOffset: '0 hour',
      }),
    ).toThrowError(TimescaleError);
  });
});
