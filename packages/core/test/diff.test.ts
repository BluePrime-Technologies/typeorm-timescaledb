import { describe, expect, it } from 'vitest';
import {
  diffSchemaState,
  isEmptyPlan,
  TimescaleError,
  type Operation,
  type Plan,
  type SchemaStateIR,
  type HypertableState,
} from '../src/index.js';

// Build a SchemaStateIR from hypertable states (CAGGs are out of scope for the diff slice).
const ir = (...hypertables: HypertableState[]): SchemaStateIR => ({
  hypertables,
  continuousAggregates: [],
});

// The plan is now a list of {operation, safety, reason} steps; most assertions care about the operations.
const ops = (plan: Plan): Operation[] => plan.steps.map((s) => s.operation);

// A fully-configured hypertable: time+space dims, columnstore, compression + retention policies.
const metric = (): HypertableState => ({
  table: 'public.metric',
  dimensions: [
    { column: 'ts', kind: 'time', chunkInterval: '1 day' },
    { column: 'device_id', kind: 'space', numPartitions: 4 },
  ],
  columnstore: {
    segmentBy: ['device_id'],
    orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
  },
  compressionPolicy: { kind: 'compression', after: '30 days' },
  retentionPolicy: { kind: 'retention', after: '365 days' },
});

// A bare hypertable: time dim only.
const events = (): HypertableState => ({
  table: 'public.events',
  dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 hour' }],
});

describe('diffSchemaState — additive (create-only) plan', () => {
  it('emits the full create sequence for a hypertable missing from current', () => {
    const plan = diffSchemaState(ir(), ir(metric()));
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.metric',
        timeColumn: 'ts',
        chunkInterval: '1 day',
        spacePartition: { column: 'device_id', partitions: 4 },
      },
      {
        kind: 'addColumnstorePolicy',
        table: 'public.metric',
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', direction: 'DESC' }],
        after: '30 days',
      },
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('emits create_hypertable only (no columnstore/policy) for a bare hypertable', () => {
    const plan = diffSchemaState(ir(), ir(events()));
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.events',
        timeColumn: 'ts',
        chunkInterval: '1 hour',
      },
    ]);
  });

  it('yields an EMPTY plan when current equals desired (no false drift)', () => {
    const plan = diffSchemaState(ir(metric(), events()), ir(metric(), events()));
    expect(ops(plan)).toEqual([]);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('adds only a retention policy that exists in desired but not current (existing table)', () => {
    const withoutRetention: HypertableState = { ...metric() };
    delete (withoutRetention as { retentionPolicy?: unknown }).retentionPolicy;
    const plan = diffSchemaState(ir(withoutRetention), ir(metric()));
    expect(ops(plan)).toEqual([
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('adds only a columnstore that exists in desired but not current (existing table)', () => {
    const bare: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
    };
    const plan = diffSchemaState(ir(bare), ir(metric()));
    // columnstore add carries the compression `after`; retention is also missing → both added.
    expect(ops(plan)).toEqual([
      {
        kind: 'addColumnstorePolicy',
        table: 'public.metric',
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', direction: 'DESC' }],
        after: '30 days',
      },
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('does NOT emit a drop for a hypertable in current but absent from desired (additive-only)', () => {
    const plan = diffSchemaState(ir(metric(), events()), ir(metric()));
    // events is only in current → no drop emitted; metric unchanged → nothing.
    expect(ops(plan)).toEqual([]);
  });

  it('does NOT emit an alter when an existing object differs in content (deferred)', () => {
    // current retention 365d, desired 90d — both present, so additive-only emits nothing (alter deferred).
    const desired = metric();
    const current: HypertableState = {
      ...metric(),
      retentionPolicy: { kind: 'retention', after: '90 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([]);
  });

  it('processes multiple new hypertables in desired order', () => {
    const plan = diffSchemaState(ir(), ir(events(), metric()));
    const tables = ops(plan).map((o) => (o as { table: string }).table);
    // events ops first (all for events), then metric ops — desired order preserved.
    expect(tables[0]).toBe('public.events');
    expect(tables.filter((t) => t === 'public.metric').length).toBeGreaterThan(0);
    expect(tables.indexOf('public.metric')).toBeGreaterThan(tables.lastIndexOf('public.events'));
  });

  it('omits the chunk interval for a bare time dimension (uses the create default)', () => {
    const bare: HypertableState = {
      table: 'public.bare',
      dimensions: [{ column: 'ts', kind: 'time' }],
    };
    const plan = diffSchemaState(ir(), ir(bare));
    expect(ops(plan)).toEqual([
      { kind: 'createHypertable', table: 'public.bare', timeColumn: 'ts' },
    ]);
  });

  it('isEmptyPlan reflects the operation count', () => {
    expect(isEmptyPlan({ steps: [] })).toBe(true);
    expect(isEmptyPlan(diffSchemaState(ir(), ir(events())))).toBe(false);
  });

  it('tags each step with its safety class + reason', () => {
    const plan = diffSchemaState(ir(), ir(metric()));
    const byKind = new Map(plan.steps.map((s) => [s.operation.kind, s]));
    // hypertable conversion + columnstore enable are one-way; a retention policy is online-safe.
    expect(byKind.get('createHypertable')?.safety).toBe('one-way');
    expect(byKind.get('addColumnstorePolicy')?.safety).toBe('one-way');
    expect(byKind.get('addRetentionPolicy')?.safety).toBe('online-safe');
    for (const step of plan.steps) expect(step.reason.length).toBeGreaterThan(0);
  });
});

// Guard + characterization tests for the unrepresentable / deferred cases the reviews surfaced. The
// diff must THROW (not silently under-converge) on desired state the string-only builders can't emit,
// and must clearly report the one known additive gap (compression policy on an already-columnstore table).
describe('diffSchemaState — unrepresentable desired state throws (no silent false convergence)', () => {
  it('throws on an integer-time chunk interval (not expressible by the builder)', () => {
    const intTime: HypertableState = {
      table: 'public.ints',
      dimensions: [{ column: 'id', kind: 'time', chunkInterval: 1_000_000 }],
    };
    expect(() => diffSchemaState(ir(), ir(intTime))).toThrow(TimescaleError);
  });

  it('throws on an integer-time retention threshold', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: 1_000_000 },
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('throws on an integer-time compression threshold', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      columnstore: { segmentBy: [], orderBy: [] },
      compressionPolicy: { kind: 'compression', after: 1_000_000 },
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('throws on a space dimension missing numPartitions (cannot emit add_dimension)', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [
        { column: 'ts', kind: 'time', chunkInterval: '1 day' },
        { column: 'device', kind: 'space' }, // no numPartitions
      ],
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('does NOT re-add a compression policy on an already-columnstore table (known additive gap)', () => {
    // current: columnstore enabled but NO compression policy; desired: columnstore + compression policy.
    // The additive slice keys the columnstore add on columnstore PRESENCE, so it emits nothing here and
    // reports converged. This is the documented gap the alter slice closes — pinned so it can't silently
    // change. (Not destructive; not a false op — a deliberate under-report.)
    const current: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
      },
    };
    const desired: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
      },
      compressionPolicy: { kind: 'compression', after: '30 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([]);
  });
});
