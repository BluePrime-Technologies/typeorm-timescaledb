import { describe, expect, it } from 'vitest';
import { extractCaggFacets, caggFacetsEqual } from '../src/cagg-facets.js';

/**
 * The fixtures below are REAL. `SERVER` is what PostgreSQL 17 / TimescaleDB 2.29.1 handed back from
 * `timescaledb_information.continuous_aggregates.view_definition` after being given `DECLARED` —
 * captured on 2026-08-14, not hand-written. The whole point of this module is surviving the
 * server's rewriting, so a hand-written "server" fixture would test nothing.
 */
const DECLARED =
  'SELECT time_bucket(INTERVAL \'1 hour\', "time") AS "bucket", "sensor_id", avg(value) AS "avg_value" FROM sensor_reading GROUP BY 1, 2';

const SERVER = ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket,
    sensor_id,
    avg(value) AS avg_value
   FROM sensor_reading
  GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;`;

describe('extractCaggFacets — the declared and stored forms must agree', () => {
  it('reads the same facets from both renderings of one aggregate', () => {
    const declared = extractCaggFacets(DECLARED);
    const server = extractCaggFacets(SERVER);

    expect(declared).toBeDefined();
    expect(server).toBeDefined();

    // This is the assertion the whole design rests on: five textual divergences, one aggregate.
    expect(caggFacetsEqual(declared!, server!)).toBe(true);

    expect(server).toEqual({
      bucketWidth: 'us:3600000000', // canonicalised, not raw text
      timeColumn: 'time',
      source: 'sensor_reading',
      groupBy: ['sensor_id'],
      aggregates: [{ fn: 'avg', column: 'value', as: 'avg_value' }],
    });
  });

  it('normalises the interval rendering, which is one of the five divergences', () => {
    // INTERVAL '1 hour' (declared) and '01:00:00'::interval (stored) are the same width rendered
    // two ways. Canonicalising through the same helper the rest of the engine uses is what makes
    // them compare equal — comparing raw text here would report drift on an unchanged aggregate.
    expect(extractCaggFacets(DECLARED)?.bucketWidth).toBe('us:3600000000');
    expect(extractCaggFacets(SERVER)?.bucketWidth).toBe('us:3600000000');
  });
});

describe('extractCaggFacets — detects the drift that matters', () => {
  const base = extractCaggFacets(SERVER)!;

  it('sees a changed bucket width', () => {
    const wider = extractCaggFacets(SERVER.replace(/01:00:00/g, '1 day'))!;
    expect(wider.bucketWidth).toBe('us:86400000000');
    expect(caggFacetsEqual(base, wider)).toBe(false);
  });

  it('sees an added GROUP BY key — a changed grain', () => {
    const regrouped = extractCaggFacets(
      ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket, sensor_id, region, avg(value) AS avg_value
         FROM sensor_reading GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id, region;`,
    )!;
    expect(regrouped.groupBy).toEqual(['region', 'sensor_id']);
    expect(caggFacetsEqual(base, regrouped)).toBe(false);
  });

  it('sees a changed aggregate function on the same column', () => {
    const summed = extractCaggFacets(SERVER.replace('avg(value)', 'sum(value)'))!;
    expect(caggFacetsEqual(base, summed)).toBe(false);
  });

  it('is insensitive to aggregate ORDER, which is not drift', () => {
    const a = extractCaggFacets(
      ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket, sensor_id,
         avg(value) AS avg_value, max(value) AS max_value
         FROM sensor_reading GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;`,
    )!;
    const b = extractCaggFacets(
      ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket, sensor_id,
         max(value) AS max_value, avg(value) AS avg_value
         FROM sensor_reading GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;`,
    )!;
    expect(caggFacetsEqual(a, b)).toBe(true);
  });

  it('handles count(*), which has no column', () => {
    const counted = extractCaggFacets(
      ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket, sensor_id, count(*) AS n
         FROM sensor_reading GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;`,
    );
    expect(counted?.aggregates).toEqual([{ fn: 'count', as: 'n' }]);
  });
});

describe('extractCaggFacets — refuses rather than guesses', () => {
  it.each([
    [
      'a WHERE clause',
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, avg(value) AS v FROM r WHERE value > 0 GROUP BY 1;',
    ],
    [
      'a join',
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, avg(value) AS v FROM r JOIN s ON s.id = r.id GROUP BY 1;',
    ],
    [
      'a nested expression',
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, avg(value * 2) AS v FROM r GROUP BY 1;',
    ],
    [
      'no aggregate at all',
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, sensor_id FROM r GROUP BY 1, 2;',
    ],
    [
      'a GROUP BY key absent from the SELECT list',
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, avg(value) AS v FROM r GROUP BY 1, region;',
    ],
    ['a bucket that is not first', ' SELECT sensor_id, avg(value) AS v FROM r GROUP BY sensor_id;'],
    [
      'unbalanced quoting',
      " SELECT time_bucket('01:00:00'::interval, \"time\") AS bucket, avg('unclosed) AS v FROM r GROUP BY 1;",
    ],
  ])('returns undefined for %s', (_label, sql) => {
    expect(extractCaggFacets(sql)).toBeUndefined();
  });

  it('undefined is a first-class result, never a throw', () => {
    expect(() => extractCaggFacets('not sql at all')).not.toThrow();
    expect(extractCaggFacets('')).toBeUndefined();
  });
});
