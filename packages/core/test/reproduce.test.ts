import { describe, expect, it } from 'vitest';
import { stateToOperations } from '../src/reproduce.js';
import { compileOperation } from '../src/operation.js';
import { classifyOperation } from '../src/safety.js';
import { createContinuousAggregateRawSQL } from '../src/sql/continuous-aggregate.js';
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
    expect(sql).toContain('create_hypertable');
    expect(sql).toContain("INTERVAL '7 days'");
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
      expect(classifyOperation(op).safety).toBeTruthy();
    }
  });
});

describe('createContinuousAggregateRawSQL', () => {
  const base = { view: 'public.v', definition: 'SELECT 1 AS x FROM t' };

  it('wraps the definition and appends WITH NO DATA exactly once', () => {
    const { up, down } = createContinuousAggregateRawSQL(base);
    expect(up).toHaveLength(1);
    expect(up[0]).toBe(
      'CREATE MATERIALIZED VIEW "public"."v" WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS SELECT 1 AS x FROM t WITH NO DATA;',
    );
    expect(down).toEqual(['DROP MATERIALIZED VIEW IF EXISTS "public"."v";']);
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
