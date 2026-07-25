import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  compileDesiredState,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  TimescaleError,
} from '../src/index.js';
import type { HypertableState, SchemaStateIR } from '@blueprime/timescaledb-core';

// --- Fixtures: decorate classes via direct invocation (no decorator syntax) ---

class Trade {}
Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['symbol'],
    orderBy: [
      { column: 'time', direction: 'DESC' },
      { column: 'price', direction: 'ASC' },
    ],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})(Trade);
TimeColumn()(Trade.prototype, 'time');
HypertablePrimaryKey()(Trade.prototype, 'time');

class Event {}
Hypertable({ chunkInterval: '1 hour' })(Event);
TimeColumn()(Event.prototype, 'ts');
HypertablePrimaryKey()(Event.prototype, 'ts');

// property names differ from physical column names (@Column({ name })), plus a space partition.
class Sensor {}
Hypertable({
  chunkInterval: '1 day',
  columnstore: { segmentBy: ['deviceId'], orderBy: [{ column: 'measuredAt', direction: 'DESC' }] },
  spacePartition: { column: 'deviceId', partitions: 4 },
})(Sensor);
TimeColumn()(Sensor.prototype, 'measuredAt');
HypertablePrimaryKey()(Sensor.prototype, 'measuredAt');
// TimescaleDB requires partitioning columns (incl. the space partition) in the PK.
HypertablePrimaryKey()(Sensor.prototype, 'deviceId');

class Plain {}

interface StubEntity {
  target: unknown;
  tableName: string;
  schema?: string;
  columns?: Array<{ propertyName: string; databaseName: string }>;
}

function stubDataSource(entities: StubEntity[]): DataSource {
  return {
    isInitialized: true,
    entityMetadatas: entities.map((e) => ({ columns: [], ...e })),
  } as unknown as DataSource;
}

function ht(ir: SchemaStateIR, table: string): HypertableState {
  const found = ir.hypertables.find((h) => h.table === table);
  if (!found)
    throw new Error(
      `hypertable ${table} not found: ${JSON.stringify(ir.hypertables.map((h) => h.table))}`,
    );
  return found;
}

describe('compileDesiredState', () => {
  it('compiles a full hypertable (dims + columnstore + compression + retention) into SchemaStateIR', () => {
    const ir = compileDesiredState(stubDataSource([{ target: Trade, tableName: 'trades' }]));
    expect(ht(ir, 'public.trades')).toEqual({
      table: 'public.trades',
      dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
      columnstore: {
        segmentBy: ['symbol'],
        orderBy: [
          { column: 'time', desc: true, nullsFirst: true }, // DESC → NULLS FIRST default
          { column: 'price', desc: false, nullsFirst: false }, // ASC → NULLS LAST default
        ],
      },
      compressionPolicy: { kind: 'compression', after: '7 days' },
      retentionPolicy: { kind: 'retention', after: '90 days' },
    });
  });

  it('compiles a bare hypertable to just a time dimension (no columnstore/policies)', () => {
    const ir = compileDesiredState(stubDataSource([{ target: Event, tableName: 'events' }]));
    expect(ht(ir, 'public.events')).toEqual({
      table: 'public.events',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 hour' }],
    });
  });

  it('resolves property names to physical columns (@Column({ name })) and adds the space dimension', () => {
    const ir = compileDesiredState(
      stubDataSource([
        {
          target: Sensor,
          tableName: 'sensors',
          columns: [
            { propertyName: 'measuredAt', databaseName: 'measured_at' },
            { propertyName: 'deviceId', databaseName: 'device_id' },
          ],
        },
      ]),
    );
    const s = ht(ir, 'public.sensors');
    expect(s.dimensions).toEqual([
      { column: 'measured_at', kind: 'time', chunkInterval: '1 day' },
      { column: 'device_id', kind: 'space', numPartitions: 4 },
    ]);
    expect(s.columnstore).toEqual({
      segmentBy: ['device_id'],
      orderBy: [{ column: 'measured_at', desc: true, nullsFirst: true }],
    });
    // property names must not leak into the IR
    expect(JSON.stringify(s)).not.toContain('measuredAt');
    expect(JSON.stringify(s)).not.toContain('deviceId');
  });

  it('always schema-qualifies (default public) so the state compares to introspect()', () => {
    const ir = compileDesiredState(
      stubDataSource([{ target: Event, tableName: 'events', schema: 'analytics' }]),
    );
    expect(ir.hypertables.map((h) => h.table)).toEqual(['analytics.events']);
  });

  it('processes hypertables deterministically (sorted by table name)', () => {
    const ir = compileDesiredState(
      stubDataSource([
        { target: Trade, tableName: 'trades' },
        { target: Event, tableName: 'events' },
      ]),
    );
    expect(ir.hypertables.map((h) => h.table)).toEqual(['public.events', 'public.trades']);
  });

  it('skips non-hypertable entities and never compiles continuous aggregates (S1 scope)', () => {
    const ir = compileDesiredState(
      stubDataSource([
        { target: Plain, tableName: 'plain' },
        { target: Event, tableName: 'events' },
      ]),
    );
    expect(ir.hypertables.map((h) => h.table)).toEqual(['public.events']);
    expect(ir.continuousAggregates).toEqual([]);
  });

  it('returns an empty state when there are no hypertables', () => {
    const ir = compileDesiredState(stubDataSource([{ target: Plain, tableName: 'p' }]));
    expect(ir).toEqual({ hypertables: [], continuousAggregates: [] });
  });

  it('throws on an uninitialized DataSource instead of a silent empty (drop-everything) state', () => {
    const uninitialized = { isInitialized: false, entityMetadatas: [] } as unknown as DataSource;
    expect(() => compileDesiredState(uninitialized)).toThrow(TimescaleError);
  });

  it('emits a columnstore (enabled) with empty arrays when declared without segmentby/orderby', () => {
    class OnlyCompress {}
    Hypertable({ chunkInterval: '1 day', columnstore: { compressAfter: '3 days' } })(OnlyCompress);
    TimeColumn()(OnlyCompress.prototype, 'ts');
    HypertablePrimaryKey()(OnlyCompress.prototype, 'ts');
    const ir = compileDesiredState(stubDataSource([{ target: OnlyCompress, tableName: 'oc' }]));
    const s = ht(ir, 'public.oc');
    expect(s.columnstore).toEqual({ segmentBy: [], orderBy: [] });
    expect(s.compressionPolicy).toEqual({ kind: 'compression', after: '3 days' });
  });
});

// Characterization tests — pin the KNOWN desired-vs-introspect divergences. This compiler encodes only
// what the decorators DECLARE; introspect() reads back the defaults the TimescaleDB engine FILLS. On an
// unchanged schema these differ, so the M4.2 diff engine (S2) MUST reconcile them via TIMESCALE_DEFAULTS
// (and must not act on CAGGs). These tests exist so S2 inherits explicit guardrails and cannot silently
// regress the reconciliation. They assert the *deliberate omissions* here, with the introspect() fill noted.
describe('compileDesiredState — deliberate omissions the S2 diff must reconcile', () => {
  class Bare {}
  Hypertable({})(Bare); // no chunkInterval declared
  TimeColumn()(Bare.prototype, 'ts');
  HypertablePrimaryKey()(Bare.prototype, 'ts');

  class Compressed {}
  Hypertable({
    chunkInterval: '1 day',
    columnstore: { compressAfter: '3 days' },
    retention: { dropAfter: '30 days' },
  })(Compressed);
  TimeColumn()(Compressed.prototype, 'ts');
  HypertablePrimaryKey()(Compressed.prototype, 'ts');

  const ds = stubDataSource([
    { target: Bare, tableName: 'bare' },
    { target: Compressed, tableName: 'compressed' },
  ]);

  it('omits time-dim chunkInterval when undeclared (introspect() fills the concrete default, e.g. "7 days")', () => {
    const dim = ht(compileDesiredState(ds), 'public.bare').dimensions[0]!;
    expect(dim).toEqual({ column: 'ts', kind: 'time' });
    expect(dim.chunkInterval).toBeUndefined(); // S2 must compare against TIMESCALE_DEFAULTS.chunkInterval
  });

  it('emits columnstore orderBy [] with only compressAfter (introspect() reads the auto-filled time-column DESC)', () => {
    const s = ht(compileDesiredState(ds), 'public.compressed');
    expect(s.columnstore?.orderBy).toEqual([]); // S2 must reconcile vs the engine-default time DESC orderby
    expect(s.columnstore?.segmentBy).toEqual([]); // segmentBy [] genuinely matches (engine default = none)
  });

  it('emits policies without scheduleInterval (every introspected background job carries one)', () => {
    const s = ht(compileDesiredState(ds), 'public.compressed');
    expect(s.compressionPolicy).toEqual({ kind: 'compression', after: '3 days' });
    expect(s.retentionPolicy).toEqual({ kind: 'retention', after: '30 days' });
    // No scheduleInterval on either → S2's policiesEqual must not treat the job's schedule as drift.
    expect(
      (s.compressionPolicy as { scheduleInterval?: unknown }).scheduleInterval,
    ).toBeUndefined();
    expect((s.retentionPolicy as { scheduleInterval?: unknown }).scheduleInterval).toBeUndefined();
  });

  it('omits timescaledbVersion (a read-time pin, not a diffed field — S2 must exclude it)', () => {
    expect(compileDesiredState(ds).timescaledbVersion).toBeUndefined();
  });

  it('always yields continuousAggregates [] — the S2 diff MUST be hypertable-scoped and never drop live CAGGs', () => {
    // A DB with CAGGs would introspect to a non-empty list; desired is always []. A naive array compare
    // in S2 would drop every CAGG — hence the hypertable-scoped contract, pinned here.
    expect(compileDesiredState(ds).continuousAggregates).toEqual([]);
  });
});
