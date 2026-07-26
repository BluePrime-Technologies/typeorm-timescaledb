import { describe, expect, it } from 'vitest';
import {
  addColumnstorePolicySQL,
  addCompressionPolicySQL,
  addContinuousAggregatePolicySQL,
  addRetentionPolicySQL,
  alterCompressionPolicySQL,
  alterRetentionPolicySQL,
  compileOperation,
  compileOperations,
  createContinuousAggregateSQL,
  createHypertableSQL,
  renameHypertableSQL,
  setChunkIntervalSQL,
  alterColumnstoreConfigSQL,
  removeRetentionPolicySQL,
  removeCompressionPolicySQL,
  TimescaleError,
  TimescaleErrorCode,
  type Operation,
  type OperationKind,
} from '../src/index.js';

// One representative Operation per variant, paired with the equivalent direct-builder call. The
// core contract of M4.1: compileOperation(op) must be byte-identical to calling the wrapped builder
// with the same fields — the operation layer adds a `kind` + a choke point, never any SQL.
const CASES: ReadonlyArray<{
  readonly kind: OperationKind;
  readonly operation: Operation;
  readonly direct: () => { up: readonly string[]; down: readonly string[]; inspect: string };
}> = [
  {
    kind: 'createHypertable',
    operation: {
      kind: 'createHypertable',
      table: 'public.metric',
      timeColumn: 'ts',
      chunkInterval: '1 day',
      spacePartition: { column: 'device_id', partitions: 4 },
    },
    direct: () =>
      createHypertableSQL({
        table: 'public.metric',
        timeColumn: 'ts',
        chunkInterval: '1 day',
        spacePartition: { column: 'device_id', partitions: 4 },
      }),
  },
  {
    kind: 'addColumnstorePolicy',
    operation: {
      kind: 'addColumnstorePolicy',
      table: 'public.metric',
      segmentBy: ['device_id', 'region'],
      orderBy: [
        { column: 'ts', direction: 'DESC' },
        { column: 'value', direction: 'ASC' },
      ],
      after: '30 days',
    },
    direct: () =>
      addColumnstorePolicySQL({
        table: 'public.metric',
        segmentBy: ['device_id', 'region'],
        orderBy: [
          { column: 'ts', direction: 'DESC' },
          { column: 'value', direction: 'ASC' },
        ],
        after: '30 days',
      }),
  },
  {
    kind: 'addRetentionPolicy',
    operation: { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    direct: () => addRetentionPolicySQL({ table: 'public.metric', dropAfter: '365 days' }),
  },
  {
    kind: 'createContinuousAggregate',
    operation: {
      kind: 'createContinuousAggregate',
      view: 'metric_hourly',
      source: 'public.metric',
      timeColumn: 'ts',
      bucketInterval: '1 hour',
      bucketAlias: 'bucket',
      groupBy: ['device_id'],
      aggregates: [{ fn: 'avg', column: 'value', as: 'avg_value' }],
      materializedOnly: false,
    },
    direct: () =>
      createContinuousAggregateSQL({
        view: 'metric_hourly',
        source: 'public.metric',
        timeColumn: 'ts',
        bucketInterval: '1 hour',
        bucketAlias: 'bucket',
        groupBy: ['device_id'],
        aggregates: [{ fn: 'avg', column: 'value', as: 'avg_value' }],
        materializedOnly: false,
      }),
  },
  {
    kind: 'addContinuousAggregatePolicy',
    operation: {
      kind: 'addContinuousAggregatePolicy',
      view: 'metric_hourly',
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '1 hour',
    },
    direct: () =>
      addContinuousAggregatePolicySQL({
        view: 'metric_hourly',
        startOffset: '1 month',
        endOffset: '1 hour',
        scheduleInterval: '1 hour',
      }),
  },
  {
    kind: 'addCompressionPolicy',
    operation: { kind: 'addCompressionPolicy', table: 'public.metric', after: '7 days' },
    direct: () => addCompressionPolicySQL({ table: 'public.metric', after: '7 days' }),
  },
  {
    kind: 'alterCompressionPolicy',
    operation: {
      kind: 'alterCompressionPolicy',
      table: 'public.metric',
      from: '7 days',
      to: '30 days',
    },
    direct: () =>
      alterCompressionPolicySQL({ table: 'public.metric', from: '7 days', to: '30 days' }),
  },
  {
    kind: 'alterRetentionPolicy',
    operation: {
      kind: 'alterRetentionPolicy',
      table: 'public.metric',
      from: '90 days',
      to: '365 days',
    },
    direct: () =>
      alterRetentionPolicySQL({ table: 'public.metric', from: '90 days', to: '365 days' }),
  },
  {
    kind: 'renameHypertable',
    operation: { kind: 'renameHypertable', from: 'public.old_metric', to: 'public.metric' },
    direct: () => renameHypertableSQL({ from: 'public.old_metric', to: 'public.metric' }),
  },
  {
    kind: 'setChunkInterval',
    operation: { kind: 'setChunkInterval', table: 'public.metric', from: '1 day', to: '7 days' },
    direct: () => setChunkIntervalSQL({ table: 'public.metric', from: '1 day', to: '7 days' }),
  },
  {
    kind: 'alterColumnstoreConfig',
    operation: {
      kind: 'alterColumnstoreConfig',
      table: 'public.metric',
      from: { segmentBy: ['device_id'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
      to: { segmentBy: ['device_id', 'region'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
    },
    direct: () =>
      alterColumnstoreConfigSQL({
        table: 'public.metric',
        from: { segmentBy: ['device_id'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
        to: { segmentBy: ['device_id', 'region'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
      }),
  },
  {
    kind: 'removeRetentionPolicy',
    operation: { kind: 'removeRetentionPolicy', table: 'public.metric', restoreAfter: '90 days' },
    direct: () => removeRetentionPolicySQL({ table: 'public.metric', restoreAfter: '90 days' }),
  },
  {
    kind: 'removeCompressionPolicy',
    operation: { kind: 'removeCompressionPolicy', table: 'public.metric', restoreAfter: '7 days' },
    direct: () => removeCompressionPolicySQL({ table: 'public.metric', restoreAfter: '7 days' }),
  },
];

describe('compileOperation — delegates to the core builders (byte-identical)', () => {
  for (const { kind, operation, direct } of CASES) {
    it(`${kind} compiles identically to its direct builder call`, () => {
      expect(compileOperation(operation)).toEqual(direct());
    });
  }

  it('covers every OperationKind (no variant left uncompilable)', () => {
    const KINDS: readonly OperationKind[] = [
      'createHypertable',
      'addColumnstorePolicy',
      'addRetentionPolicy',
      'createContinuousAggregate',
      'addContinuousAggregatePolicy',
      'addCompressionPolicy',
      'alterCompressionPolicy',
      'alterRetentionPolicy',
      'renameHypertable',
      'setChunkInterval',
      'alterColumnstoreConfig',
      'removeRetentionPolicy',
      'removeCompressionPolicy',
    ];
    // The cases exercise each declared kind exactly once — a new union member without a test fails here.
    expect([...new Set(CASES.map((c) => c.kind))].sort()).toEqual([...KINDS].sort());
    for (const { operation } of CASES) {
      const stmt = compileOperation(operation);
      expect(stmt.up.length).toBeGreaterThan(0);
      expect(stmt.down.length).toBeGreaterThan(0);
      expect(typeof stmt.inspect).toBe('string');
    }
  });

  // Minimal-shape cases (optionals OMITTED). Because the wrapper is a pure pass-through with no
  // defaulting, compileOperation must still equal the direct call when optional fields are absent —
  // this pins that the operation layer never injects a default that the builder didn't. Each also
  // exercises a builder branch the all-fields cases skip (no chunkInterval/spacePartition; the
  // columnstore non-destructive-notice `down`; the CAGG policy without schedule_interval).
  it('createHypertable with no chunkInterval/spacePartition equals the direct builder', () => {
    expect(
      compileOperation({ kind: 'createHypertable', table: 'public.m', timeColumn: 'ts' }),
    ).toEqual(createHypertableSQL({ table: 'public.m', timeColumn: 'ts' }));
  });

  it('addColumnstorePolicy with after omitted (non-destructive down) equals the direct builder', () => {
    expect(
      compileOperation({
        kind: 'addColumnstorePolicy',
        table: 'public.m',
        segmentBy: ['device_id'],
      }),
    ).toEqual(addColumnstorePolicySQL({ table: 'public.m', segmentBy: ['device_id'] }));
  });

  it('addContinuousAggregatePolicy without scheduleInterval equals the direct builder', () => {
    expect(
      compileOperation({
        kind: 'addContinuousAggregatePolicy',
        view: 'mv',
        startOffset: '1 month',
        endOffset: '1 hour',
      }),
    ).toEqual(
      addContinuousAggregatePolicySQL({ view: 'mv', startOffset: '1 month', endOffset: '1 hour' }),
    );
  });

  it('propagates the builder validation errors (safety stays in the builders)', () => {
    // A 3-part table is rejected by parseTable inside the builder — compileOperation must not swallow it.
    expect(() =>
      compileOperation({ kind: 'addRetentionPolicy', table: 'a.b.c', dropAfter: '1 day' }),
    ).toThrow(TimescaleError);
  });

  it('throws a typed error on an unknown discriminant (JS/any caller)', () => {
    // Simulate an untyped caller passing a bogus kind; the exhaustiveness default must reject it.
    const bogus = { kind: 'dropEverything', table: 'x' } as unknown as Operation;
    try {
      compileOperation(bogus);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimescaleError);
      expect((err as TimescaleError).code).toBe(TimescaleErrorCode.INVALID_ARGUMENT);
      expect((err as TimescaleError).message).toContain('dropEverything');
    }
  });
});

describe('compileOperations — order-preserving map', () => {
  it('compiles a list in order, one MigrationStatement per operation', () => {
    const ops: Operation[] = CASES.map((c) => c.operation);
    const compiled = compileOperations(ops);
    expect(compiled).toHaveLength(ops.length);
    compiled.forEach((stmt, i) => {
      expect(stmt).toEqual(CASES[i]!.direct());
    });
  });

  it('returns an empty array for no operations', () => {
    expect(compileOperations([])).toEqual([]);
  });
});
