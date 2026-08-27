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
      bucketAlias: 'bucket', // part of the view's public shape, so renaming it is drift
      source: 'public.sensor_reading', // canonicalised: the server omits the schema, the declared side qualifies it
      groupBy: [{ column: 'sensor_id' }],
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
    expect(regrouped.groupBy).toEqual([{ column: 'region' }, { column: 'sensor_id' }]);
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

describe('extractCaggFacets — identifier case, the false positive adversarial review caught', () => {
  it('folds UNQUOTED identifiers, because PostgreSQL does', () => {
    // Measured on PG17/TSDB 2.29.1: declaring `AS Bucket` / `AS AvgValue` unquoted and reading
    // view_definition back returns `AS bucket` / `AS avgvalue`. Comparing without folding reports
    // drift on an aggregate nobody changed — `check` failing on a converged database.
    const declared =
      "SELECT time_bucket(INTERVAL '1 hour', time) AS Bucket, sensor_id, avg(value) AS AvgValue FROM readings GROUP BY 1, 2";
    const server =
      ' SELECT time_bucket(\'01:00:00\'::interval, "time") AS bucket, sensor_id, avg(value) AS avgvalue FROM readings GROUP BY (time_bucket(\'01:00:00\'::interval, "time")), sensor_id;';
    expect(caggFacetsEqual(extractCaggFacets(declared)!, extractCaggFacets(server)!)).toBe(true);
    expect(extractCaggFacets(declared)?.aggregates[0]?.as).toBe('avgvalue');
  });

  it('preserves the case of a QUOTED identifier, where case IS significant', () => {
    // "AvgValue" quoted is a genuinely different column from avgvalue; folding it would make two
    // different aggregates compare equal — a false NEGATIVE, the mirror mistake.
    const quoted =
      'SELECT time_bucket(INTERVAL \'1 hour\', time) AS "Bucket", sensor_id, avg(value) AS "AvgValue" FROM readings GROUP BY 1, 2';
    expect(extractCaggFacets(quoted)?.aggregates[0]?.as).toBe('AvgValue');
  });

  it('folds an unquoted relation but not a quoted one', () => {
    const unquoted =
      "SELECT time_bucket(INTERVAL '1 h', t) AS b, s, avg(v) AS a FROM Public.Readings GROUP BY 1, 2";
    const quoted =
      'SELECT time_bucket(INTERVAL \'1 h\', t) AS b, s, avg(v) AS a FROM "Public"."readings" GROUP BY 1, 2';
    expect(extractCaggFacets(unquoted)?.source).toBe('public.readings');
    expect(extractCaggFacets(quoted)?.source).toBe('Public.readings');
  });
});

describe('extractCaggFacets — pathological input must not hang', () => {
  it('handles a definition with a huge run of whitespace in linear time', () => {
    // CodeQL flagged polynomial backtracking here: "may run slow on strings starting with
    // 'select ' and with many repetitions of '  '". The input is genuinely uncontrolled — it is
    // pg_get_viewdef output — so a pathological view definition could have hung the diff.
    const pathological = `SELECT${' '.repeat(50_000)}a FROM b GROUP BY 1`;
    const started = Date.now();
    expect(extractCaggFacets(pathological)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('handles a long unterminated quote without blowing up', () => {
    const started = Date.now();
    expect(extractCaggFacets(`SELECT "${'a'.repeat(50_000)}`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/**
 * Regression suite for the five defects the review panel found on `4919362`.
 *
 * Every case here is a pair of definitions that MUST NOT compare equal. Before the fix each pair
 * did compare equal (or, for the FROM-alias case, fabricated drift on a converged database) and no
 * test in the suite above could fail on any of them — the original tests proved the happy path and
 * the refusal paths only.
 */
describe('extractCaggFacets — differences that MUST be reported', () => {
  const base =
    "SELECT time_bucket('1 hour'::interval, ts) AS bucket, sensor_id, avg(value) AS avg_value FROM readings GROUP BY 1, 2";

  const mustDiffer = (label: string, a: string, b: string): void => {
    it(label, () => {
      const fa = extractCaggFacets(a);
      const fb = extractCaggFacets(b);
      expect(fa, `left side must parse: ${a}`).toBeDefined();
      expect(fb, `right side must parse: ${b}`).toBeDefined();
      if (fa === undefined || fb === undefined) return;
      expect(caggFacetsEqual(fa, fb)).toBe(false);
    });
  };

  // HIGH — the bucket alias was sliced off and discarded.
  mustDiffer(
    'a renamed BUCKET column is drift, not a no-op',
    base,
    base.replace('AS bucket', 'AS ts_bucket'),
  );

  // HIGH — the grouped-column alias was captured by the regex but never stored.
  mustDiffer(
    'a renamed GROUPED column is drift, not a no-op',
    base,
    base.replace('bucket, sensor_id,', 'bucket, sensor_id AS sid,'),
  );

  // HIGH — canonicalizeInterval's 30-day month collapsed these onto one key.
  mustDiffer(
    'a month bucket is NOT a 30-day bucket',
    base.replace("'1 hour'", "'1 mon'"),
    base.replace("'1 hour'", "'30 days'"),
  );

  mustDiffer(
    'a year bucket is NOT a 360-day bucket',
    base.replace("'1 hour'", "'1 year'"),
    base.replace("'1 hour'", "'360 days'"),
  );

  it('still treats equivalent renderings of a FIXED width as equal', () => {
    const a = extractCaggFacets(base);
    const b = extractCaggFacets(base.replace("'1 hour'", "'01:00:00'"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    expect(caggFacetsEqual(a, b)).toBe(true);
  });

  it('keys a month width separately from any µs width', () => {
    const month = extractCaggFacets(base.replace("'1 hour'", "'1 mon'"));
    expect(month?.bucketWidth).toBe('mon:1|us:0');
    expect(extractCaggFacets(base)?.bucketWidth).toBe('us:3600000000');
  });
});

describe('extractCaggFacets — shapes that must REFUSE rather than fabricate drift', () => {
  it('refuses a FROM with a table alias, instead of inventing "public.readings r"', () => {
    // Parsing this produced a relation no server rendering can ever equal, which under step 2's
    // blocking advisory would turn a converged database's `check` permanently red.
    expect(
      extractCaggFacets(
        "SELECT time_bucket('1 hour'::interval, ts) AS bucket, sensor_id, avg(value) AS avg_value FROM readings r GROUP BY 1, 2",
      ),
    ).toBeUndefined();
  });

  it('refuses FROM ONLY t for the same reason', () => {
    expect(
      extractCaggFacets(
        "SELECT time_bucket('1 hour'::interval, ts) AS bucket, sensor_id, avg(value) AS avg_value FROM ONLY readings GROUP BY 1, 2",
      ),
    ).toBeUndefined();
  });

  it('folds each relation part independently under MIXED quoting', () => {
    // One `wasQuoted` flag over the whole string folded both parts together, so an unquoted schema
    // kept its case whenever the table happened to be quoted.
    const mixed = extractCaggFacets(
      'SELECT time_bucket(\'1 hour\'::interval, ts) AS bucket, sensor_id, avg(value) AS avg_value FROM PUBLIC."Sensor" GROUP BY 1, 2',
    );
    expect(mixed?.source).toBe('public.Sensor');
  });
});

describe('caggFacetsEqual — public API, so hand-built literals must behave', () => {
  it('is insensitive to key order and to explicit-undefined vs omitted', () => {
    const parsed = extractCaggFacets(
      "SELECT time_bucket('1 hour'::interval, ts) AS bucket, sensor_id, count(*) AS n FROM readings GROUP BY 1, 2",
    );
    expect(parsed).toBeDefined();
    if (parsed === undefined) return;

    // Same facts, different key order, and `column` written explicitly as undefined for count(*).
    const handBuilt = {
      aggregates: [{ as: 'n', column: undefined, fn: 'count' }],
      groupBy: [{ as: undefined, column: 'sensor_id' }],
      source: 'public.readings',
      bucketAlias: 'bucket',
      timeColumn: 'ts',
      bucketWidth: 'us:3600000000',
    };

    expect(caggFacetsEqual(parsed, handBuilt)).toBe(true);
    expect(JSON.stringify(parsed) === JSON.stringify(handBuilt)).toBe(false);
  });
});
