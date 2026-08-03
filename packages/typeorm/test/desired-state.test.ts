import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  compileDesiredState,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  ContinuousAggregate,
  BucketColumn,
  GroupColumn,
  AggregateColumn,
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

  it('skips non-hypertable entities and compiles no CAGGs when none are passed', () => {
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

  it('yields continuousAggregates [] when the list is NOT passed — the diff must never drop live CAGGs', () => {
    // CAGG classes cannot be discovered from a DataSource (module-private WeakMap, not entities), so
    // omitting the list is indistinguishable from "this project has none". A DB with CAGGs would
    // introspect to a non-empty list against this empty desired one; a naive array compare would drop
    // every CAGG. Hence the never-drop contract, pinned here. The `check` advisory covers the
    // user-facing half: it must fire on an ABSENT list, not merely on an uncompared CAGG.
    expect(compileDesiredState(ds).continuousAggregates).toEqual([]);
    expect(compileDesiredState(ds, {}).continuousAggregates).toEqual([]);
    expect(compileDesiredState(ds, { continuousAggregates: [] }).continuousAggregates).toEqual([]);
  });
});

// The CAGG half of the compiler. CAGG classes are passed EXPLICITLY (option B) because they live in
// a module-private WeakMap and are not TypeORM entities — there is no way to discover them from a
// DataSource. These tests cover the capability itself: flat + hierarchical compilation, property ->
// physical-column resolution, refresh mapping, and ordering.
describe('compileDesiredState — continuous aggregates', () => {
  class Reading {}
  Hypertable({ chunkInterval: '1 day' })(Reading);
  TimeColumn()(Reading.prototype, 'time');
  HypertablePrimaryKey()(Reading.prototype, 'time');

  // Source whose properties are remapped to physical columns via @Column({ name }).
  class Mapped {}
  Hypertable({ chunkInterval: '1 day' })(Mapped);
  TimeColumn()(Mapped.prototype, 'measuredAt');
  HypertablePrimaryKey()(Mapped.prototype, 'measuredAt');

  class ReadingHourly {}
  ContinuousAggregate({ name: 'reading_hourly', source: Reading, bucket: '1 hour' })(ReadingHourly);
  BucketColumn()(ReadingHourly.prototype, 'bucket');
  GroupColumn()(ReadingHourly.prototype, 'sensor');
  AggregateColumn({ fn: 'avg', column: 'value' })(ReadingHourly.prototype, 'avgValue');

  class MappedByDevice {}
  ContinuousAggregate({
    name: 'mapped_by_device',
    source: Mapped,
    bucket: '1 day',
    materializedOnly: true,
  })(MappedByDevice);
  BucketColumn()(MappedByDevice.prototype, 'day');
  GroupColumn()(MappedByDevice.prototype, 'deviceId');
  AggregateColumn({ fn: 'sum', column: 'reading' })(MappedByDevice.prototype, 'total');

  class Refreshed {}
  ContinuousAggregate({
    name: 'refreshed',
    source: Reading,
    bucket: '1 hour',
    refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '30 minutes' },
  })(Refreshed);
  BucketColumn()(Refreshed.prototype, 'bucket');
  AggregateColumn({ fn: 'count' })(Refreshed.prototype, 'n');

  class DefaultSchedule {}
  ContinuousAggregate({
    name: 'default_schedule',
    source: Reading,
    bucket: '2 hours',
    refresh: { startOffset: '7 days', endOffset: '1 hour' },
  })(DefaultSchedule);
  BucketColumn()(DefaultSchedule.prototype, 'bucket');
  AggregateColumn({ fn: 'count' })(DefaultSchedule.prototype, 'n');

  // Hierarchical: a daily rollup built FROM the hourly CAGG, not from the hypertable.
  class HourlyRollup {}
  ContinuousAggregate({ name: 'hourly_rollup', source: Mapped, bucket: '1 hour' })(HourlyRollup);
  BucketColumn()(HourlyRollup.prototype, 'bucket');
  GroupColumn()(HourlyRollup.prototype, 'deviceId');
  AggregateColumn({ fn: 'sum', column: 'reading' })(HourlyRollup.prototype, 'sumValue');

  class DailyRollup {}
  ContinuousAggregate({ name: 'daily_rollup', source: HourlyRollup, bucket: '1 day' })(DailyRollup);
  BucketColumn()(DailyRollup.prototype, 'bucket');
  GroupColumn()(DailyRollup.prototype, 'deviceId');
  AggregateColumn({ fn: 'sum', column: 'sumValue' })(DailyRollup.prototype, 'sumValue');

  const MAPPED_COLUMNS = [
    { propertyName: 'measuredAt', databaseName: 'measured_at' },
    { propertyName: 'deviceId', databaseName: 'device_id' },
    { propertyName: 'reading', databaseName: 'reading_value' },
  ];

  const ds = stubDataSource([
    { target: Reading, tableName: 'readings' },
    { target: Mapped, tableName: 'mapped', columns: MAPPED_COLUMNS },
  ]);

  const withSchema = stubDataSource([
    { target: Reading, tableName: 'readings', schema: 'analytics' },
    { target: Mapped, tableName: 'mapped', columns: MAPPED_COLUMNS },
  ]);

  const cagg = (ir: SchemaStateIR, viewName: string) => {
    const found = ir.continuousAggregates.find((c) => c.viewName === viewName);
    if (!found)
      throw new Error(
        `cagg ${viewName} not found: ${JSON.stringify(ir.continuousAggregates.map((c) => c.viewName))}`,
      );
    return found;
  };

  it('compiles a flat CAGG into ContinuousAggregateState', () => {
    const c = cagg(
      compileDesiredState(ds, { continuousAggregates: [ReadingHourly] }),
      'public.reading_hourly',
    );
    expect(c.source).toBe('public.readings');
    expect(c.hierarchical).toBe(false);
    expect(c.materializedOnly).toBe(false);
    expect(c.refresh).toBeUndefined();
    // The definition is rendered by the SAME renderer the CREATE builder embeds, so desired text is
    // exactly what the engine would emit. It is deliberately NOT comparable to the catalog's
    // view_definition (a parse-tree deparse) — see the diff engine's presence-only contract.
    expect(c.definition).toBe(
      `SELECT time_bucket(INTERVAL '1 hour', "time") AS "bucket", "sensor", avg("value") AS "avgValue" FROM "public"."readings" GROUP BY time_bucket(INTERVAL '1 hour', "time"), "sensor"`,
    );
  });

  it('resolves source property names to physical columns (@Column({ name })) in the definition', () => {
    const c = cagg(
      compileDesiredState(ds, { continuousAggregates: [MappedByDevice] }),
      'public.mapped_by_device',
    );
    expect(c.materializedOnly).toBe(true);
    // time column, group column and the aggregate's argument are all SOURCE columns → physical names.
    expect(c.definition).toContain('"measured_at"');
    expect(c.definition).toContain('"device_id"');
    expect(c.definition).toContain('sum("reading_value")');
    // ...but the CAGG's own OUTPUT names are its property names, verbatim.
    expect(c.definition).toContain('AS "day"');
    expect(c.definition).toContain('AS "total"');
    // Source-side property names must never leak into the emitted SQL.
    expect(c.definition).not.toContain('measuredAt');
    expect(c.definition).not.toContain('deviceId');
    expect(c.definition).not.toContain('"reading"');
  });

  it('maps a declared refresh policy onto the IR policy shape', () => {
    const c = cagg(
      compileDesiredState(ds, { continuousAggregates: [Refreshed] }),
      'public.refreshed',
    );
    expect(c.refresh).toEqual({
      kind: 'refresh',
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '30 minutes',
    });
  });

  it('defaults an omitted scheduleInterval to the bucket width (2.18 has no overload without it)', () => {
    const c = cagg(
      compileDesiredState(ds, { continuousAggregates: [DefaultSchedule] }),
      'public.default_schedule',
    );
    expect(c.refresh?.scheduleInterval).toBe('2 hours');
  });

  it('compiles a hierarchical CAGG, sourcing it from the parent VIEW and ordering it after the parent', () => {
    // Declared child-first on purpose: the topological pass must reorder, else `push` would try to
    // create the daily rollup before the hourly view it reads from.
    const ir = compileDesiredState(ds, { continuousAggregates: [DailyRollup, HourlyRollup] });
    expect(ir.continuousAggregates.map((c) => c.viewName)).toEqual([
      'public.hourly_rollup',
      'public.daily_rollup',
    ]);

    const child = cagg(ir, 'public.daily_rollup');
    expect(child.hierarchical).toBe(true);
    expect(child.source).toBe('public.hourly_rollup');
    // Reading FROM a view: the group column resolves to the PARENT's projected output name, which for
    // an unaliased @GroupColumn is the parent's SOURCE physical column ('device_id', not 'deviceId').
    expect(child.definition).toContain('FROM "public"."hourly_rollup"');
    expect(child.definition).toContain('"device_id"');
    // The parent's aggregate output IS property-named, so the child re-aggregates it verbatim.
    expect(child.definition).toContain('sum("sumValue")');
  });

  // REGRESSION. The IR is compared against introspect(), which reports `view_schema.view_name` and
  // `raw_schema.raw_table` — ALWAYS qualified. The decorator's `name` is normally bare, and emitting
  // it bare here made every CAGG that ALREADY EXISTS look absent to the diff, so the additive pass
  // would emit a CREATE for a live view (`push --apply` then fails, or silently claims convergence).
  // Nothing in the SQL output reveals this — the builder qualifies bare names itself — so only an
  // IR-shape assertion catches it.
  it('schema-qualifies viewName and source, matching introspect() (bare names default to public)', () => {
    const ir = compileDesiredState(ds, { continuousAggregates: [ReadingHourly, MappedByDevice] });
    for (const c of ir.continuousAggregates) {
      expect(c.viewName).toMatch(/^[^.]+\.[^.]+$/);
      expect(c.source).toMatch(/^[^.]+\.[^.]+$/);
    }
    expect(ir.continuousAggregates.map((c) => c.viewName).sort()).toEqual([
      'public.mapped_by_device',
      'public.reading_hourly',
    ]);
  });

  it("uses the source entity's own schema, not a hardcoded public", () => {
    const c = cagg(
      compileDesiredState(withSchema, { continuousAggregates: [ReadingHourly] }),
      'public.reading_hourly',
    );
    expect(c.source).toBe('analytics.readings');
    expect(c.definition).toContain('FROM "analytics"."readings"');
  });

  it('does not double-qualify a CAGG declared with an explicit schema.view name', () => {
    class Explicit {}
    ContinuousAggregate({ name: 'reports.explicit', source: Reading, bucket: '1 hour' })(Explicit);
    BucketColumn()(Explicit.prototype, 'bucket');
    AggregateColumn({ fn: 'count' })(Explicit.prototype, 'n');

    const ir = compileDesiredState(ds, { continuousAggregates: [Explicit] });
    expect(ir.continuousAggregates.map((c) => c.viewName)).toEqual(['reports.explicit']);
  });

  it('compiles hypertables and CAGGs together, leaving hypertable compilation unchanged', () => {
    const ir = compileDesiredState(ds, { continuousAggregates: [ReadingHourly] });
    expect(ir.hypertables.map((h) => h.table)).toEqual(['public.mapped', 'public.readings']);
    expect(ir.continuousAggregates).toHaveLength(1);
  });

  it('rejects a class that is not decorated with @ContinuousAggregate', () => {
    expect(() => compileDesiredState(ds, { continuousAggregates: [Plain] })).toThrow(
      TimescaleError,
    );
  });

  it('rejects a CAGG whose source is neither a registered hypertable nor another CAGG', () => {
    class Orphan {}
    Hypertable({ chunkInterval: '1 day' })(Orphan);
    TimeColumn()(Orphan.prototype, 'ts');
    HypertablePrimaryKey()(Orphan.prototype, 'ts');
    class OrphanHourly {}
    ContinuousAggregate({ name: 'orphan_hourly', source: Orphan, bucket: '1 hour' })(OrphanHourly);
    BucketColumn()(OrphanHourly.prototype, 'bucket');
    AggregateColumn({ fn: 'count' })(OrphanHourly.prototype, 'n');

    // `Orphan` is decorated but never registered on this DataSource.
    expect(() => compileDesiredState(ds, { continuousAggregates: [OrphanHourly] })).toThrow(
      /is neither a registered @Hypertable entity nor a @ContinuousAggregate/,
    );
  });

  it('rejects a circular CAGG source dependency instead of looping or emitting a partial list', () => {
    class CycA {}
    class CycB {}
    ContinuousAggregate({ name: 'cyc_a', source: CycB, bucket: '1 hour' })(CycA);
    ContinuousAggregate({ name: 'cyc_b', source: CycA, bucket: '1 hour' })(CycB);
    BucketColumn()(CycA.prototype, 'bucket');
    AggregateColumn({ fn: 'count' })(CycA.prototype, 'n');
    BucketColumn()(CycB.prototype, 'bucket');
    AggregateColumn({ fn: 'count' })(CycB.prototype, 'n');

    expect(() => compileDesiredState(ds, { continuousAggregates: [CycA, CycB] })).toThrow(
      /circular source dependency/,
    );
  });

  it('de-duplicates a CAGG class passed twice', () => {
    const ir = compileDesiredState(ds, { continuousAggregates: [ReadingHourly, ReadingHourly] });
    expect(ir.continuousAggregates.map((c) => c.viewName)).toEqual(['public.reading_hourly']);
  });
});

describe('compileDesiredState — single-table inheritance (audit)', () => {
  // TypeORM registers one entity metadata per SUBCLASS, all mapped to the SAME physical table.
  class Base {}
  Hypertable({ chunkInterval: '1 day' })(Base);
  TimeColumn()(Base.prototype, 'ts');
  HypertablePrimaryKey()(Base.prototype, 'ts');

  class SubA extends Base {}
  class SubB extends Base {}

  it('emits ONE hypertable for N subclasses mapped to one table', () => {
    // Previously this produced N duplicate hypertables — an N-times-repeated migration, and a diff
    // comparing the table against itself.
    const ds = stubDataSource([
      { target: SubA, tableName: 'events' },
      { target: SubB, tableName: 'events' },
    ]);
    const ir = compileDesiredState(ds);
    expect(ir.hypertables).toHaveLength(1);
    expect(ir.hypertables[0]?.table).toBe('public.events');
  });

  it('refuses CONFLICTING declarations for the same physical table', () => {
    class OtherBase {}
    Hypertable({ chunkInterval: '7 days' })(OtherBase);
    TimeColumn()(OtherBase.prototype, 'ts');
    HypertablePrimaryKey()(OtherBase.prototype, 'ts');

    const ds = stubDataSource([
      { target: SubA, tableName: 'events' }, // 1 day
      { target: OtherBase, tableName: 'events' }, // 7 days — disagrees
    ]);
    expect(() => compileDesiredState(ds)).toThrow(/CONFLICTING/);
  });
});
