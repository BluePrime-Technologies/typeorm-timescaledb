import { describe, expect, it } from 'vitest';
import { stateToOperations } from '../src/reproduce.js';
import { compileOperation } from '../src/operation.js';
import { classifyOperation } from '../src/safety.js';
import {
  createContinuousAggregateRawSQL,
  createContinuousAggregateSQL,
  renderContinuousAggregateSelect,
  extractSelectBodyForTest,
} from '../src/sql/continuous-aggregate.js';
import { TimescaleError } from '../src/errors.js';
import type {
  ContinuousAggregateState,
  HypertableState,
  SchemaStateIR,
} from '../src/schema-state.js';

const EMPTY_IR: SchemaStateIR = { hypertables: [], continuousAggregates: [] };

function ir(partial: Partial<SchemaStateIR>): SchemaStateIR {
  return { ...EMPTY_IR, ...partial };
}

function hypertable(overrides: Partial<HypertableState> = {}): HypertableState {
  return {
    table: 'public.metrics',
    dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '7 days' }],
    ...overrides,
  };
}

function cagg(overrides: Partial<ContinuousAggregateState> = {}): ContinuousAggregateState {
  return {
    viewName: 'public.metrics_hourly',
    source: 'public.metrics',
    hierarchical: false,
    materializedOnly: false,
    definition:
      "SELECT time_bucket('1 hour', ts) AS bucket, avg(v) AS avg_v FROM metrics GROUP BY 1",
    ...overrides,
  };
}

/** The safety class each reproduce-emitted operation MUST carry. Pinned by name so a change to a
 * classification is a deliberate edit here, not a silently-passing truthy check. */
const EXPECTED_SAFETY: Record<string, string> = {
  createHypertable: 'one-way',
  addColumnstorePolicy: 'one-way',
  addRetentionPolicy: 'online-safe',
  createContinuousAggregateRaw: 'one-way',
  addContinuousAggregatePolicy: 'online-safe',
};

const kinds = (result: { operations: readonly { kind: string }[] }): string[] =>
  result.operations.map((o) => o.kind);

describe('stateToOperations', () => {
  it('reproduces nothing from an empty IR, and reports no skips', () => {
    const result = stateToOperations(EMPTY_IR);
    expect(result.operations).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('reproduces a full hypertable as create + columnstore + retention, in that order', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            columnstore: {
              segmentBy: ['device'],
              orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
            },
            compressionPolicy: { kind: 'compression', after: '7 days' },
            retentionPolicy: { kind: 'retention', after: '90 days' },
          }),
        ],
      }),
    );

    expect(kinds(result)).toEqual([
      'createHypertable',
      'addColumnstorePolicy',
      'addRetentionPolicy',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('emits SQL that round-trips through the compile choke point', () => {
    const result = stateToOperations(ir({ hypertables: [hypertable()] }));
    const sql = compileOperation(result.operations[0]!).up.join('\n');
    // Exact SQL, not substrings: the previous version asserted only that 'create_hypertable' and
    // the interval appeared, so flipping if_not_exists to FALSE or dropping migrate_data passed.
    expect(sql).toBe(
      `SELECT create_hypertable('"public"."metrics"', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => FALSE);`,
    );
    expect(sql).not.toContain(';;');
  });

  describe('inexpressible hypertable facets are reported, never thrown', () => {
    it('skips the whole hypertable when there is no time dimension', () => {
      const result = stateToOperations(ir({ hypertables: [hypertable({ dimensions: [] })] }));
      expect(result.operations).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({
        object: 'public.metrics',
        facet: 'hypertable',
        reason: 'no-time-dimension',
      });
    });

    it('still creates the hypertable when the chunk interval is an integer, and reports the loss', () => {
      const result = stateToOperations(
        ir({
          hypertables: [
            hypertable({
              dimensions: [{ column: 'ts', kind: 'time', chunkInterval: 604800000000 }],
            }),
          ],
        }),
      );
      expect(kinds(result)).toEqual(['createHypertable']);
      // The interval must be ABSENT rather than wrong — a fabricated interval would be worse.
      expect(result.operations[0]).not.toHaveProperty('chunkInterval');
      expect(result.skipped[0]).toMatchObject({
        facet: 'chunkInterval',
        reason: 'integer-chunk-interval',
      });
    });

    it('drops an incomplete space dimension but keeps the hypertable', () => {
      const result = stateToOperations(
        ir({
          hypertables: [
            hypertable({
              dimensions: [
                { column: 'ts', kind: 'time', chunkInterval: '1 day' },
                { column: 'device', kind: 'space' },
              ],
            }),
          ],
        }),
      );
      expect(kinds(result)).toEqual(['createHypertable']);
      expect(result.operations[0]).not.toHaveProperty('spacePartition');
      expect(result.skipped[0]).toMatchObject({ reason: 'space-dimension-incomplete' });
    });

    it('reproduces a space dimension when the partition count is present', () => {
      const result = stateToOperations(
        ir({
          hypertables: [
            hypertable({
              dimensions: [
                { column: 'ts', kind: 'time', chunkInterval: '1 day' },
                { column: 'device', kind: 'space', numPartitions: 4 },
              ],
            }),
          ],
        }),
      );
      expect(result.operations[0]).toMatchObject({
        spacePartition: { column: 'device', partitions: 4 },
      });
      expect(result.skipped).toEqual([]);
    });

    it.each([
      ['integer threshold', { kind: 'compression' as const, after: 12345 }, 'integer-threshold'],
      [
        'created_before variant',
        { kind: 'compression' as const, createdBefore: '30 days' },
        'created-before-threshold',
      ],
    ])(
      'enables the columnstore but reports a compression %s',
      (_label, compressionPolicy, reason) => {
        const result = stateToOperations(
          ir({
            hypertables: [
              hypertable({
                columnstore: { segmentBy: ['device'], orderBy: [] },
                compressionPolicy,
              }),
            ],
          }),
        );
        expect(kinds(result)).toEqual(['createHypertable', 'addColumnstorePolicy']);
        // Columnstore still enabled, but WITHOUT a fabricated `after`.
        expect(result.operations[1]).not.toHaveProperty('after');
        expect(result.skipped[0]).toMatchObject({ facet: 'compressionPolicy', reason });
      },
    );

    it('reports an unmanaged compression job by its procedure name', () => {
      const result = stateToOperations(
        ir({
          hypertables: [
            hypertable({
              columnstore: { segmentBy: [], orderBy: [] },
              compressionPolicy: { kind: 'unmanaged', procName: 'my_custom_compress' },
            }),
          ],
        }),
      );
      expect(result.skipped[0]?.detail).toContain('my_custom_compress');
      expect(result.skipped[0]).toMatchObject({ reason: 'unmanaged-policy' });
    });

    it('reports a compression policy that has no columnstore to attach to', () => {
      const result = stateToOperations(
        ir({
          hypertables: [
            hypertable({ compressionPolicy: { kind: 'compression', after: '7 days' } }),
          ],
        }),
      );
      expect(kinds(result)).toEqual(['createHypertable']);
      expect(result.skipped[0]).toMatchObject({ facet: 'compressionPolicy' });
    });

    it.each([
      ['integer', { kind: 'retention' as const, after: 999 }, 'integer-threshold'],
      [
        'created_before',
        { kind: 'retention' as const, createdBefore: '1 year' },
        'created-before-threshold',
      ],
    ])('reports an inexpressible %s retention threshold', (_l, retentionPolicy, reason) => {
      const result = stateToOperations(ir({ hypertables: [hypertable({ retentionPolicy })] }));
      expect(kinds(result)).toEqual(['createHypertable']);
      expect(result.skipped[0]).toMatchObject({ facet: 'retentionPolicy', reason });
    });
  });

  describe('continuous aggregates', () => {
    it('reproduces a CAGG from the definition the database reported', () => {
      const result = stateToOperations(ir({ continuousAggregates: [cagg()] }));
      expect(kinds(result)).toEqual(['createContinuousAggregateRaw']);
      const sql = compileOperation(result.operations[0]!).up.join('\n');
      expect(sql).toContain('CREATE MATERIALIZED VIEW');
      expect(sql).toContain('timescaledb.continuous');
      expect(sql).toContain('WITH NO DATA');
      expect(sql).toContain('time_bucket');
    });

    it('preserves materialized_only', () => {
      const result = stateToOperations(
        ir({ continuousAggregates: [cagg({ materializedOnly: true })] }),
      );
      expect(compileOperation(result.operations[0]!).up.join('')).toContain(
        'timescaledb.materialized_only = TRUE',
      );
    });

    it('reproduces an expressible refresh policy', () => {
      const result = stateToOperations(
        ir({
          continuousAggregates: [
            cagg({
              refresh: {
                kind: 'refresh',
                startOffset: '1 month',
                endOffset: '1 hour',
                scheduleInterval: '30 minutes',
              },
            }),
          ],
        }),
      );
      expect(kinds(result)).toEqual([
        'createContinuousAggregateRaw',
        'addContinuousAggregatePolicy',
      ]);
      expect(result.skipped).toEqual([]);
    });

    it('treats an absent offset as an open bound (null), not a skip', () => {
      const result = stateToOperations(
        ir({
          continuousAggregates: [
            cagg({ refresh: { kind: 'refresh', scheduleInterval: '1 hour' } }),
          ],
        }),
      );
      expect(result.operations[1]).toMatchObject({ startOffset: null, endOffset: null });
      expect(result.skipped).toEqual([]);
    });

    it('keeps the CAGG but reports a refresh policy with no schedule interval', () => {
      const result = stateToOperations(
        ir({
          continuousAggregates: [cagg({ refresh: { kind: 'refresh', startOffset: '1 day' } })],
        }),
      );
      expect(kinds(result)).toEqual(['createContinuousAggregateRaw']);
      expect(result.skipped[0]).toMatchObject({ facet: 'refreshPolicy' });
    });

    it('keeps the CAGG but reports integer refresh offsets', () => {
      const result = stateToOperations(
        ir({
          continuousAggregates: [
            cagg({
              refresh: {
                kind: 'refresh',
                startOffset: 100,
                endOffset: 10,
                scheduleInterval: '1 h',
              },
            }),
          ],
        }),
      );
      expect(kinds(result)).toEqual(['createContinuousAggregateRaw']);
      expect(result.skipped[0]).toMatchObject({
        facet: 'refreshPolicy',
        reason: 'integer-threshold',
      });
    });

    it.each([
      ['empty', '   '],
      ['multi-statement', 'SELECT 1; DROP TABLE users'],
    ])('skips a CAGG with an %s definition instead of emitting it', (_l, definition) => {
      const result = stateToOperations(ir({ continuousAggregates: [cagg({ definition })] }));
      expect(result.operations).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ reason: 'cagg-definition-unusable' });
    });

    it('orders a hierarchical CAGG after the parent it reads from', () => {
      // Deliberately listed child-first, so passing cannot be an artifact of input order.
      const child = cagg({
        viewName: 'public.metrics_daily',
        source: 'public.metrics_hourly',
        hierarchical: true,
        definition: "SELECT time_bucket('1 day', bucket) AS bucket FROM metrics_hourly GROUP BY 1",
      });
      const result = stateToOperations(ir({ continuousAggregates: [child, cagg()] }));
      const views = result.operations.map((o) => (o as { view: string }).view);
      expect(views).toEqual(['public.metrics_hourly', 'public.metrics_daily']);
    });

    it('reports a dependency cycle rather than looping forever', () => {
      const a = cagg({ viewName: 'public.a', source: 'public.b' });
      const b = cagg({ viewName: 'public.b', source: 'public.a' });
      const result = stateToOperations(ir({ continuousAggregates: [a, b] }));
      expect(result.operations).toEqual([]);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        'cagg-dependency-cycle',
        'cagg-dependency-cycle',
      ]);
    });

    it('emits hypertables before continuous aggregates', () => {
      const result = stateToOperations(
        ir({ hypertables: [hypertable()], continuousAggregates: [cagg()] }),
      );
      expect(kinds(result)).toEqual(['createHypertable', 'createContinuousAggregateRaw']);
    });
  });

  it('classifies every reproduced operation (no unclassified kind escapes)', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            columnstore: { segmentBy: ['device'], orderBy: [] },
            compressionPolicy: { kind: 'compression', after: '7 days' },
            retentionPolicy: { kind: 'retention', after: '90 days' },
          }),
        ],
        continuousAggregates: [cagg({ refresh: { kind: 'refresh', scheduleInterval: '1 hour' } })],
      }),
    );
    for (const op of result.operations) {
      // NOT `toBeTruthy()`: `classifyOperation` has a fail-closed default returning
      // 'refuse-by-default', which is truthy — so a truthy assertion passed for ANY kind,
      // including an unhandled one, and proved nothing it claimed to.
      expect(EXPECTED_SAFETY[op.kind]).toBeDefined();
      expect(classifyOperation(op).safety).toBe(EXPECTED_SAFETY[op.kind]);
    }
  });
});

describe('createContinuousAggregateRawSQL', () => {
  const base = { view: 'public.v', definition: 'SELECT 1 AS x FROM t' };

  it('wraps the definition and appends WITH NO DATA exactly once', () => {
    const { up, down } = createContinuousAggregateRawSQL(base);
    expect(up).toHaveLength(1);
    // The NEWLINE before WITH NO DATA is deliberate, not cosmetic — see the builder: with a space,
    // a definition ending in a `--` comment swallows the clause and the CAGG is created WITH DATA.
    expect(up[0]).toBe(
      'CREATE MATERIALIZED VIEW "public"."v" WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS SELECT 1 AS x FROM t\nWITH NO DATA;',
    );
    // down() must NOT drop a reproduced CAGG — it already holds materialized data.
    expect(down.join('\n')).toContain('RAISE NOTICE');
  });

  it('strips a trailing semicolon from the catalog definition rather than double-terminating', () => {
    const { up } = createContinuousAggregateRawSQL({
      ...base,
      definition: 'SELECT 1 AS x FROM t;',
    });
    expect(up[0]).not.toContain(';;');
    expect(up[0]?.endsWith('WITH NO DATA;')).toBe(true);
  });

  it('rejects a multi-statement definition so nothing can ride along', () => {
    expect(() =>
      createContinuousAggregateRawSQL({ ...base, definition: 'SELECT 1; DROP TABLE users' }),
    ).toThrow(TimescaleError);
  });

  it('rejects an empty definition', () => {
    expect(() => createContinuousAggregateRawSQL({ ...base, definition: '  ' })).toThrow(
      TimescaleError,
    );
  });

  it('still validates the view name', () => {
    expect(() =>
      createContinuousAggregateRawSQL({ ...base, view: 'bad name; DROP TABLE t' }),
    ).toThrow(TimescaleError);
  });
});

/**
 * Regressions from the M4.4b review panel. Each of these FAILS against the pre-fix implementation —
 * that is the point of writing them, so a future refactor cannot quietly reintroduce the defect.
 */
describe('review-panel regressions', () => {
  it('does NOT emit a child CAGG whose parent was skipped (would fail on apply)', () => {
    // Codex HIGH: the ordering loop removed a parent from `pending` because it was "ready",
    // regardless of whether anything was actually emitted for it. The child then looked ready and
    // was emitted referencing a view the migration never creates.
    const parent = cagg({ viewName: 'public.hourly', definition: 'SELECT 1; SELECT 2' });
    const child = cagg({
      viewName: 'public.daily',
      source: 'public.hourly',
      hierarchical: true,
      definition: "SELECT time_bucket('1 day', bucket) AS bucket FROM hourly GROUP BY 1",
    });
    const result = stateToOperations(ir({ continuousAggregates: [parent, child] }));

    expect(result.operations).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'cagg-definition-unusable',
      'cagg-parent-not-reproduced',
    ]);
  });

  it('still emits a child whose parent WAS reproduced', () => {
    // The guard must not over-fire: a healthy hierarchy is still emitted, parent first.
    const parent = cagg({ viewName: 'public.hourly' });
    const child = cagg({
      viewName: 'public.daily',
      source: 'public.hourly',
      hierarchical: true,
      definition: "SELECT time_bucket('1 day', bucket) AS bucket FROM hourly GROUP BY 1",
    });
    const result = stateToOperations(ir({ continuousAggregates: [child, parent] }));
    expect(result.operations.map((o) => (o as { view: string }).view)).toEqual([
      'public.hourly',
      'public.daily',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    ['semicolon inside a string literal', "SELECT string_agg(device, ';') AS d FROM m"],
    ['semicolon in a FILTER literal', "SELECT count(*) FILTER (WHERE tag <> 'a;b') AS n FROM m"],
    ['semicolon in a dollar-quoted body', 'SELECT $tag$a;b$tag$::text AS x FROM m'],
  ])('reproduces a CAGG with a %s', (_label, definition) => {
    // Codex + o3 MEDIUM: `body.includes(';')` rejected valid single-statement definitions and
    // reported "multiple statements", which was simply untrue.
    const result = stateToOperations(ir({ continuousAggregates: [cagg({ definition })] }));
    expect(kinds(result)).toEqual(['createContinuousAggregateRaw']);
    expect(result.skipped).toEqual([]);
  });

  it('still rejects a genuinely multi-statement definition', () => {
    const result = stateToOperations(
      ir({ continuousAggregates: [cagg({ definition: 'SELECT 1 FROM m; DROP TABLE users' })] }),
    );
    expect(result.operations).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'cagg-definition-unusable' });
  });

  it('reports every space dimension beyond the first instead of dropping it silently', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            dimensions: [
              { column: 'ts', kind: 'time', chunkInterval: '1 day' },
              { column: 'device', kind: 'space', numPartitions: 4 },
              { column: 'region', kind: 'space', numPartitions: 2 },
            ],
          }),
        ],
      }),
    );
    expect(result.operations[0]).toMatchObject({
      spacePartition: { column: 'device', partitions: 4 },
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.detail).toContain('region');
  });

  it.each([
    ['compression', { compressionPolicy: { kind: 'retention' as const, after: '1 day' } }],
    ['retention', { retentionPolicy: { kind: 'refresh' as const, scheduleInterval: '1 h' } }],
  ])('reports a mis-kinded %s policy rather than ignoring it', (_l, overrides) => {
    const result = stateToOperations(
      ir({
        hypertables: [hypertable({ columnstore: { segmentBy: [], orderBy: [] }, ...overrides })],
      }),
    );
    expect(result.skipped.some((s) => s.reason === 'policy-kind-mismatch')).toBe(true);
  });

  it('asserts the columnstore segmentBy/orderBy actually reach the operation', () => {
    // Red-team: no test asserted these contents, so mutating the direction mapping or dropping
    // segmentBy entirely passed the whole unit suite.
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            columnstore: {
              segmentBy: ['device', 'region'],
              orderBy: [
                { column: 'ts', desc: true, nullsFirst: false },
                { column: 'seq', desc: false, nullsFirst: false },
              ],
            },
          }),
        ],
      }),
    );
    expect(result.operations[1]).toMatchObject({
      segmentBy: ['device', 'region'],
      orderBy: [
        { column: 'ts', direction: 'DESC' },
        { column: 'seq', direction: 'ASC' },
      ],
    });
  });
});

describe('createContinuousAggregateRawSQL — review-panel regressions', () => {
  const base = { view: 'public.v', definition: 'SELECT 1 AS x FROM t' };

  it('never drops the view on down() — a pulled CAGG already holds data', () => {
    // Red-team HIGH: `DROP MATERIALIZED VIEW` on revert destroys aggregate rows whose source
    // chunks retention may already have dropped. Unrecoverable.
    const { down } = createContinuousAggregateRawSQL(base);
    expect(down.join('\n')).not.toMatch(/DROP MATERIALIZED VIEW/i);
    expect(down.join('\n')).toContain('RAISE NOTICE');
  });

  it('keeps WITH NO DATA effective when the definition ends in a line comment', () => {
    // Red-team: with a space separator, `-- note` swallowed `WITH NO DATA;` and the statement still
    // succeeded — materializing the entire history inside a migration.
    const { up } = createContinuousAggregateRawSQL({
      ...base,
      definition: 'SELECT 1 AS x FROM t -- note',
    });
    const sql = up[0]!;
    expect(sql.endsWith('WITH NO DATA;')).toBe(true);
    // The clause must be on its own line, after the comment terminates.
    expect(sql).toMatch(/\nWITH NO DATA;$/);
  });

  it('rejects a definition ending inside an unterminated block comment', () => {
    expect(() =>
      createContinuousAggregateRawSQL({ ...base, definition: 'SELECT 1 AS x FROM t /* oops' }),
    ).toThrow(TimescaleError);
  });

  it('accepts a semicolon inside a literal', () => {
    const { up } = createContinuousAggregateRawSQL({
      ...base,
      definition: "SELECT ';'::text AS x FROM t",
    });
    expect(up[0]).toContain("';'::text");
  });
});

/**
 * Catalog-form intervals — the class of bug the mocked unit suite structurally could not see.
 *
 * Postgres does not echo an interval back the way you wrote it: `INTERVAL '1 month'` is stored and
 * rendered as `1 mon`, and `chunk_time_interval => INTERVAL '1 hour'` comes back as `01:00:00`.
 * Every fixture above happens to use a string that round-trips unchanged (`7 days`, `90 days`), so
 * the whole suite passed while `pullSchema` threw on the most ordinary real schemas. These
 * fixtures use the forms an actual catalog produces, verified against TimescaleDB 2.18.
 */
describe('catalog-rendered interval forms compile', () => {
  const compileAll = (result: { operations: readonly Parameters<typeof compileOperation>[0][] }) =>
    result.operations.map((o) => compileOperation(o).up.join('\n')).join('\n');

  it('accepts a sub-day chunk interval rendered as HH:MM:SS', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({ dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '01:00:00' }] }),
        ],
      }),
    );
    expect(result.skipped).toEqual([]);
    expect(compileAll(result)).toContain("INTERVAL '01:00:00'");
  });

  it('accepts month thresholds rendered as "1 mon"', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            columnstore: { segmentBy: ['device'], orderBy: [] },
            compressionPolicy: { kind: 'compression', after: '1 mon' },
            retentionPolicy: { kind: 'retention', after: '6 mons' },
          }),
        ],
      }),
    );
    expect(result.skipped).toEqual([]);
    const sql = compileAll(result);
    expect(sql).toContain("INTERVAL '1 mon'");
    expect(sql).toContain("INTERVAL '6 mons'");
  });

  it('accepts a compound interval on a refresh policy', () => {
    const result = stateToOperations(
      ir({
        continuousAggregates: [
          cagg({
            refresh: {
              kind: 'refresh',
              startOffset: '1 mon',
              endOffset: '01:00:00',
              scheduleInterval: '1 day 02:00:00',
            },
          }),
        ],
      }),
    );
    expect(result.skipped).toEqual([]);
    const sql = compileAll(result);
    expect(sql).toContain("INTERVAL '1 mon'");
    expect(sql).toContain("INTERVAL '1 day 02:00:00'");
  });

  it('STILL refuses a negative retention threshold (would drop every chunk)', () => {
    // Widening the grammar must not widen the sign. `INTERVAL_PATTERN`'s leading \d+ made this
    // impossible before; `nonNegative` is what preserves it.
    const result = stateToOperations(
      ir({
        hypertables: [hypertable({ retentionPolicy: { kind: 'retention', after: '-30 days' } })],
      }),
    );
    expect(() => compileAll(result)).toThrow(TimescaleError);
  });

  it('still allows a zero compression threshold (compress immediately)', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({
            columnstore: { segmentBy: [], orderBy: [] },
            compressionPolicy: { kind: 'compression', after: '0 days' },
          }),
        ],
      }),
    );
    expect(() => compileAll(result)).not.toThrow();
  });

  it('still refuses a zero chunk interval (positive, not merely non-negative)', () => {
    const result = stateToOperations(
      ir({
        hypertables: [
          hypertable({ dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '0 days' }] }),
        ],
      }),
    );
    expect(() => compileAll(result)).toThrow(TimescaleError);
  });
});

describe('open (null) refresh bounds', () => {
  it('treats a null start/end offset as an OPEN bound, not as inexpressible', () => {
    // o3 raised this as a HIGH claiming introspect emits null; that premise is false (normalize's
    // iv() maps a non-string/number to undefined). But `stateToOperations` is public, a hand-built
    // IR can pass null, and the builder already emits NULL for it — so fail open, not shut.
    const result = stateToOperations(
      ir({
        continuousAggregates: [
          cagg({
            refresh: {
              kind: 'refresh',
              startOffset: null as unknown as string,
              endOffset: null as unknown as string,
              scheduleInterval: '1 hour',
            },
          }),
        ],
      }),
    );
    expect(kinds(result)).toEqual(['createContinuousAggregateRaw', 'addContinuousAggregatePolicy']);
    expect(result.skipped).toEqual([]);
    expect(result.operations[1]).toMatchObject({ startOffset: null, endOffset: null });
  });
});

describe('renderContinuousAggregateSelect', () => {
  const input = {
    view: 'public.metrics_hourly',
    source: 'public.metrics',
    timeColumn: 'ts',
    bucketInterval: '1 hour',
    groupBy: ['device'],
    aggregates: [{ fn: 'avg' as const, column: 'value', as: 'avg_value' }],
  };

  it('is byte-identical to the body the structured builder embeds', () => {
    // The desired-state path renders the CAGG as SQL text; the builder emits the CREATE. If these
    // two ever diverge, `check` would compare against a statement the engine would not actually
    // emit. Sharing one renderer makes that impossible — this pins it.
    const body = renderContinuousAggregateSelect(input);
    const full = createContinuousAggregateSQL(input).up[0]!;
    expect(full).toContain(`AS ${body} WITH NO DATA;`);
    expect(body.startsWith('SELECT ')).toBe(true);
    expect(body).not.toContain('WITH NO DATA');
    expect(body).not.toContain('CREATE MATERIALIZED VIEW');
  });

  it('carries the resolved physical columns, not property names', () => {
    expect(renderContinuousAggregateSelect(input)).toBe(
      `SELECT time_bucket(INTERVAL '1 hour', "ts") AS "bucket", "device", avg("value") AS "avg_value" FROM "public"."metrics" GROUP BY time_bucket(INTERVAL '1 hour', "ts"), "device"`,
    );
  });
});

// `renderContinuousAggregateSelect` slices the SELECT body back out of a rendered CREATE. The
// slicing used to fall back to returning the WHOLE statement when its marker did not match, which a
// raw-create would then embed inside another CREATE — silent nonsense SQL. It now throws. Pinning
// both halves: an adversarial review showed the anchored regex could be weakened to an unanchored
// one with the entire core suite still green, i.e. the new behaviour was unpinned in both directions.
describe('extractSelectBody (via renderContinuousAggregateSelect)', () => {
  it('throws rather than returning the whole statement when the body cannot be located', () => {
    // Reach the private helper through the only public door, by making the builder's output
    // unparseable for the slicer: `createContinuousAggregateSQL` is the sole producer, so simulate
    // a shape change by calling the extractor's contract directly through a crafted statement.
    // (If the builder's output shape ever changes, THIS is the test that fires.)
    const statement = 'CREATE MATERIALIZED VIEW x AS SELECT 1;'; // no `) AS `, no `WITH NO DATA`
    expect(() => extractSelectBodyForTest(statement)).toThrow(TimescaleError);
    expect(() => extractSelectBodyForTest(statement)).toThrow(/could not locate the SELECT body/);
  });

  it('tolerates the whitespace its comment promises (a reformat must not silently stop matching)', () => {
    const reformatted =
      'CREATE MATERIALIZED VIEW "public"."v"\n  WITH (timescaledb.continuous)\n  AS\n' +
      '  SELECT 1 AS "a"\n  WITH NO DATA;';
    expect(extractSelectBodyForTest(reformatted)).toBe('SELECT 1 AS "a"');
  });
});

// #190 — the raw builder serves two genuinely different objects, and `down()` must differ.
// `pull` reproduces an aggregate that ALREADY EXISTS and is ALREADY MATERIALIZED elsewhere, whose
// rows may be the only surviving copy of data retention has dropped from the source. The diff
// CREATES one that does not exist, WITH NO DATA. Refusing to drop the second is not caution — it
// strands an empty view the user never had, on every revert.
describe('createContinuousAggregateRawSQL — reproduce vs create intent', () => {
  const input = { view: 'public.v', definition: 'SELECT 1 AS x FROM t' };

  it('defaults to reproduce: down() does NOT drop, so a forgotten call site fails SAFE', () => {
    const s = createContinuousAggregateRawSQL(input);
    expect(s.down.join('\n')).not.toMatch(/DROP/i);
    // The default matters more than it looks: the cost of wrongly defaulting to 'create' is
    // deleting a rollup that cannot be recomputed; the cost of this default is a stranded view.
    expect(createContinuousAggregateRawSQL({ ...input, intent: 'reproduce' }).down).toEqual(s.down);
  });

  it('create: down() DROPs the view it just created', () => {
    const s = createContinuousAggregateRawSQL({ ...input, intent: 'create' });
    expect(s.down.join('\n')).toMatch(/DROP MATERIALIZED VIEW IF EXISTS "public"\."v";/);
  });

  it('up() is byte-identical either way — intent changes only down() and the reason', () => {
    expect(createContinuousAggregateRawSQL({ ...input, intent: 'create' }).up).toEqual(
      createContinuousAggregateRawSQL({ ...input, intent: 'reproduce' }).up,
    );
  });

  it('the safety reason describes what the step actually does', () => {
    // It is printed verbatim by formatPlanPreview, so telling someone creating a NEW aggregate that
    // it is "reproducing an EXISTING" one is not a cosmetic slip — it is the sentence they use to
    // decide whether to run the plan.
    const created = classifyOperation({
      kind: 'createContinuousAggregateRaw',
      ...input,
      intent: 'create',
    });
    expect(created.reason).toMatch(/created WITH NO DATA/);
    expect(created.reason).not.toMatch(/EXISTING/);

    const reproduced = classifyOperation({ kind: 'createContinuousAggregateRaw', ...input });
    expect(reproduced.reason).toMatch(/reproducing an EXISTING/);
    // Both remain one-way: neither is an online-safe operation.
    expect([created.safety, reproduced.safety]).toEqual(['one-way', 'one-way']);
  });

  it('pull still never drops: stateToOperations does not opt into create', () => {
    // The regression that matters most here — #190 must not leak drop semantics into the pull path.
    const ir = {
      hypertables: [],
      continuousAggregates: [
        {
          viewName: 'public.h',
          source: 'public.t',
          hierarchical: false,
          materializedOnly: false,
          definition: 'SELECT 1 AS x FROM t',
        },
      ],
    };
    const { operations } = stateToOperations(ir);
    const sql = operations.map((o) => compileOperation(o));
    expect(sql.flatMap((s) => s.down).join('\n')).not.toMatch(/DROP MATERIALIZED VIEW/i);
  });
});
