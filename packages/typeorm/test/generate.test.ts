import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import { diffSchemaState, type Plan, type SchemaStateIR } from '@blueprime/timescaledb-core';
import {
  generateTimescaleMigration,
  planToMigration,
  renderTimescaleMigration,
  renderTimescaleMigrationSql,
  createTimescaleMigration,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  ContinuousAggregate,
  BucketColumn,
  GroupColumn,
  AggregateColumn,
  getContinuousAggregateMeta,
  TimescaleError,
} from '../src/index.js';

// A valid 13-digit (JS millisecond) timestamp — TypeORM parses the last 13 chars
// of the migration class name as its ordering key.
const TS = 1700000000000;

// --- Fixtures: decorate classes via direct invocation (no decorator syntax) ---

class Trade {}
Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['symbol'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
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

// An entity whose property names differ from physical column names (@Column({ name })).
class Sensor {}
Hypertable({
  chunkInterval: '1 day',
  columnstore: { segmentBy: ['deviceId'], orderBy: [{ column: 'measuredAt', direction: 'DESC' }] },
})(Sensor);
TimeColumn()(Sensor.prototype, 'measuredAt');
HypertablePrimaryKey()(Sensor.prototype, 'measuredAt');

class Plain {}

interface StubEntity {
  target: unknown;
  tableName: string;
  schema?: string;
  columns?: Array<{ propertyName: string; databaseName: string }>;
}

/** Build a stub of an initialized DataSource exposing entityMetadatas. */
function stubDataSource(entities: StubEntity[]): DataSource {
  return {
    isInitialized: true,
    entityMetadatas: entities.map((e) => ({ columns: [], ...e })),
  } as unknown as DataSource;
}

describe('generateTimescaleMigration', () => {
  it('emits hypertable → columnstore → retention in up, and the reverse in down', () => {
    const ds = stubDataSource([{ target: Trade, tableName: 'trades' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });

    expect(gen.name).toBe(`Timescale${TS}`);
    expect(gen.timestamp).toBe(TS);
    expect(gen.up).toEqual([
      `SELECT create_hypertable('"public"."trades"', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => FALSE);`,
      `ALTER TABLE "public"."trades" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"symbol"', timescaledb.orderby = '"time" DESC');`,
      `CALL add_columnstore_policy('"public"."trades"', after => INTERVAL '7 days', if_not_exists => TRUE);`,
      `SELECT add_retention_policy('"public"."trades"', drop_after => INTERVAL '90 days', if_not_exists => TRUE);`,
    ]);
    expect(gen.down[0]).toBe(
      `SELECT remove_retention_policy('"public"."trades"', if_exists => TRUE);`,
    );
    expect(gen.down[1]).toBe(
      `CALL remove_columnstore_policy('"public"."trades"', if_exists => TRUE);`,
    );
    expect(gen.down[2]).toContain('RAISE NOTICE');
    expect(gen.down).toHaveLength(3);
  });

  it('maps entity property names to physical column names (@Column({ name }))', () => {
    const ds = stubDataSource([
      {
        target: Sensor,
        tableName: 'sensors',
        columns: [
          { propertyName: 'measuredAt', databaseName: 'measured_at' },
          { propertyName: 'deviceId', databaseName: 'device_id' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    expect(gen.up[0]).toContain(`by_range('measured_at', INTERVAL '1 day')`);
    expect(gen.up.join('\n')).toContain(`timescaledb.segmentby = '"device_id"'`);
    expect(gen.up.join('\n')).toContain(`timescaledb.orderby = '"measured_at" DESC'`);
    // the property names must NOT leak into the SQL
    expect(gen.up.join('\n')).not.toContain('measuredAt');
    expect(gen.up.join('\n')).not.toContain('deviceId');
  });

  it('skips non-hypertable entities', () => {
    const ds = stubDataSource([
      { target: Plain, tableName: 'plain' },
      { target: Event, tableName: 'events' },
    ]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    expect(gen.up.join('\n')).not.toContain('plain');
    expect(gen.up.join('\n')).toContain('"public"."events"');
  });

  it('processes entities deterministically (sorted by table name)', () => {
    const ds = stubDataSource([
      { target: Trade, tableName: 'trades' },
      { target: Event, tableName: 'events' },
    ]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    const firstEvents = gen.up.findIndex((s) => s.includes('"events"'));
    const firstTrades = gen.up.findIndex((s) => s.includes('"trades"'));
    expect(firstEvents).toBeLessThan(firstTrades); // 'events' < 'trades'
  });

  it('honors a non-default schema', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events', schema: 'analytics' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    expect(gen.up[0]).toContain(`create_hypertable('"analytics"."events"'`);
  });

  it('supports a custom name prefix and rejects an invalid one', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    expect(generateTimescaleMigration(ds, { name: 'InitHypertables', timestamp: TS }).name).toBe(
      `InitHypertables${TS}`,
    );
    expect(() => generateTimescaleMigration(ds, { name: '9 bad-name' })).toThrow(TimescaleError);
  });

  it('rejects a timestamp that is not a 13-digit integer (TypeORM ordering key)', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    for (const bad of [1, -1, 1.5, 999_999_999_999, 10_000_000_000_000]) {
      expect(() => generateTimescaleMigration(ds, { timestamp: bad })).toThrow(TimescaleError);
    }
    // a real millisecond timestamp is accepted
    expect(generateTimescaleMigration(ds, { timestamp: TS }).timestamp).toBe(TS);
  });

  it('throws on an uninitialized DataSource instead of silently emitting an empty migration', () => {
    const uninitialized = {
      isInitialized: false,
      entityMetadatas: [],
    } as unknown as DataSource;
    expect(() => generateTimescaleMigration(uninitialized, { timestamp: TS })).toThrow(
      TimescaleError,
    );
  });

  it('returns empty statement lists when there are no hypertables', () => {
    const gen = generateTimescaleMigration(stubDataSource([{ target: Plain, tableName: 'p' }]), {
      timestamp: TS,
    });
    expect(gen.up).toEqual([]);
    expect(gen.down).toEqual([]);
  });
});

describe('renderTimescaleMigration', () => {
  it('renders a valid TypeORM migration class with one query() per statement', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    const src = renderTimescaleMigration(gen);

    expect(src).toContain('Generated by typeorm-timescaledb');
    expect(src).toContain('down() is intentionally non-destructive');
    // type-only import — required under verbatimModuleSyntax
    expect(src).toContain("import type { MigrationInterface, QueryRunner } from 'typeorm';");
    expect(src).toContain(`export class Timescale${TS} implements MigrationInterface {`);
    expect(src).toContain(`name = 'Timescale${TS}';`);
    expect(src).toContain('public async up(queryRunner: QueryRunner): Promise<void> {');
    for (const sql of gen.up) {
      expect(src).toContain(`await queryRunner.query(${JSON.stringify(sql)});`);
    }
  });

  it('renders a no-op body when there is nothing to do', () => {
    const gen = generateTimescaleMigration(stubDataSource([]), { timestamp: TS });
    expect(renderTimescaleMigration(gen)).toContain('// no-op');
  });
});

// A small hand-built desired IR → an additive plan (createHypertable + retention), used to exercise
// the diff-Plan → migration bridge without a live DB (diffSchemaState is pure).
const ir = (...hypertables: SchemaStateIR['hypertables']): SchemaStateIR => ({
  hypertables,
  continuousAggregates: [],
});
const samplePlan = (): Plan =>
  diffSchemaState(
    ir(),
    ir({
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: '30 days' },
    }),
  );

describe('planToMigration — diff Plan → GeneratedMigration bridge', () => {
  it('maps a plan to a GeneratedMigration with the resolved name/timestamp and reversible up/down', () => {
    const plan = samplePlan();
    const gen = planToMigration(plan, { timestamp: TS });
    expect(gen.name).toBe(`Timescale${TS}`);
    expect(gen.timestamp).toBe(TS);
    // up carries the create + policy; down (reversed) removes the retention policy (non-destructive).
    expect(gen.up.join('\n')).toMatch(/create_hypertable/);
    expect(gen.up.join('\n')).toMatch(/add_retention_policy/);
    expect(gen.down.join('\n')).toMatch(/remove_retention_policy/);
  });

  it('defaults the class-name prefix to Timescale', () => {
    const gen = planToMigration(samplePlan(), { timestamp: TS });
    expect(gen.name).toBe(`Timescale${TS}`);
  });

  it('honours a custom name prefix', () => {
    const gen = planToMigration(samplePlan(), { name: 'AddRetention', timestamp: TS });
    expect(gen.name).toBe(`AddRetention${TS}`);
  });

  it('rejects an invalid name prefix (shared validation with generateTimescaleMigration)', () => {
    expect(() => planToMigration(samplePlan(), { name: '1bad', timestamp: TS })).toThrow(
      TimescaleError,
    );
  });

  it('rejects a non-13-digit timestamp', () => {
    expect(() => planToMigration(samplePlan(), { timestamp: 123 })).toThrow(TimescaleError);
  });

  it('emits empty up/down for an empty plan', () => {
    const gen = planToMigration({ steps: [] }, { timestamp: TS });
    expect(gen.up).toEqual([]);
    expect(gen.down).toEqual([]);
  });
});

describe('renderTimescaleMigrationSql — raw .sql emit target', () => {
  it('renders -- Up / -- Down sections with ;-terminated statements and a header', () => {
    const gen = planToMigration(samplePlan(), { timestamp: TS });
    const sql = renderTimescaleMigrationSql(gen);

    expect(sql).toContain('Generated by typeorm-timescaledb');
    expect(sql).toContain('down is intentionally non-destructive');
    expect(sql).toContain(`-- Migration: Timescale${TS}`);
    expect(sql).toContain('-- Up');
    expect(sql).toContain('-- Down');
    // Statements are written verbatim — the builders already carry a trailing `;`, so the emitter
    // must NOT append another (no `;;`).
    for (const stmt of gen.up) {
      expect(stmt.endsWith(';')).toBe(true);
      expect(sql).toContain(stmt);
    }
    for (const stmt of gen.down) expect(sql).toContain(stmt);
    expect(sql).not.toContain(';;');
    // Up appears before Down.
    expect(sql.indexOf('-- Up')).toBeLessThan(sql.indexOf('-- Down'));
  });

  it('renders a -- no-op section when a side is empty', () => {
    const sql = renderTimescaleMigrationSql({
      name: `Timescale${TS}`,
      timestamp: TS,
      up: [],
      down: [],
    });
    expect(sql).toContain('-- no-op');
  });
});

describe('createTimescaleMigration', () => {
  it('runs each statement in order against a query runner', async () => {
    const ds = stubDataSource([{ target: Trade, tableName: 'trades' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: TS });
    const migration = createTimescaleMigration(gen);

    const calls: string[] = [];
    const runner = {
      query: async (q: string): Promise<unknown[]> => {
        calls.push(q);
        return [];
      },
    } as unknown as QueryRunner;

    await migration.up(runner);
    expect(calls).toEqual([...gen.up]);

    calls.length = 0;
    await migration.down(runner);
    expect(calls).toEqual([...gen.down]);

    expect(migration.name).toBe(`Timescale${TS}`);
  });
});

// --- Continuous-aggregate fixtures (M2.5b) ---

class Reading {}
Hypertable({ chunkInterval: '1 day' })(Reading);
TimeColumn()(Reading.prototype, 'time');
HypertablePrimaryKey()(Reading.prototype, 'time');

class ReadingHourly {}
ContinuousAggregate({ name: 'reading_hourly', source: Reading, bucket: '1 hour' })(ReadingHourly);
BucketColumn()(ReadingHourly.prototype, 'bucket');
GroupColumn()(ReadingHourly.prototype, 'sensor');
AggregateColumn({ fn: 'avg', column: 'value' })(ReadingHourly.prototype, 'avgValue');
AggregateColumn({ fn: 'count' })(ReadingHourly.prototype, 'samples');

// A CAGG whose source maps property -> physical column via @Column({ name }).
class Mapped {}
Hypertable({ chunkInterval: '1 day' })(Mapped);
TimeColumn()(Mapped.prototype, 'measuredAt');
HypertablePrimaryKey()(Mapped.prototype, 'measuredAt');

class MappedDaily {}
ContinuousAggregate({
  name: 'mapped_daily',
  source: Mapped,
  bucket: '1 day',
  materializedOnly: true,
})(MappedDaily);
BucketColumn()(MappedDaily.prototype, 'day');
AggregateColumn({ fn: 'sum', column: 'reading' })(MappedDaily.prototype, 'total');

// A CAGG that groups by a source column remapped via @Column({ name }) — exercises
// group-column property -> physical-name resolution (and the unaliased output name).
class MappedByDevice {}
ContinuousAggregate({ name: 'mapped_by_device', source: Mapped, bucket: '1 day' })(MappedByDevice);
BucketColumn()(MappedByDevice.prototype, 'day');
GroupColumn()(MappedByDevice.prototype, 'deviceId');
AggregateColumn({ fn: 'sum', column: 'reading' })(MappedByDevice.prototype, 'total');

// A source hypertable whose @TimeColumn ('createdAt') is deliberately NOT the column the
// CAGG buckets on — the CAGG overrides it with `timeColumn: 'eventTime'`.
class Multi {}
Hypertable({ chunkInterval: '1 day' })(Multi);
TimeColumn()(Multi.prototype, 'createdAt');
HypertablePrimaryKey()(Multi.prototype, 'createdAt');

class MultiByEvent {}
ContinuousAggregate({
  name: 'multi_by_event',
  source: Multi,
  bucket: '1 hour',
  timeColumn: 'eventTime',
})(MultiByEvent);
BucketColumn()(MultiByEvent.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(MultiByEvent.prototype, 'n');

// A CAGG whose source is a registered entity that is NOT a @Hypertable → NOT_A_HYPERTABLE.
class CaggOnPlain {}
ContinuousAggregate({ name: 'cagg_on_plain', source: Plain, bucket: '1 hour' })(CaggOnPlain);
BucketColumn()(CaggOnPlain.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(CaggOnPlain.prototype, 'n');

// Structurally-incomplete CAGGs (validated lazily by getContinuousAggregateMeta).
class NoBucket {}
ContinuousAggregate({ name: 'no_bucket', source: Reading, bucket: '1 hour' })(NoBucket);
AggregateColumn({ fn: 'count' })(NoBucket.prototype, 'n');

class NoAggregate {}
ContinuousAggregate({ name: 'no_aggregate', source: Reading, bucket: '1 hour' })(NoAggregate);
BucketColumn()(NoAggregate.prototype, 'bucket');

// A CAGG whose bucket output name collides with an aggregate output name.
class DupCols {}
ContinuousAggregate({ name: 'dup_cols', source: Reading, bucket: '1 hour' })(DupCols);
BucketColumn()(DupCols.prototype, 'total');
AggregateColumn({ fn: 'sum', column: 'value' })(DupCols.prototype, 'total');

// A CAGG with an explicit refresh policy (all three offsets set).
class ReadingHourlyRefreshed {}
ContinuousAggregate({
  name: 'reading_hourly_refreshed',
  source: Reading,
  bucket: '1 hour',
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '30 minutes' },
})(ReadingHourlyRefreshed);
BucketColumn()(ReadingHourlyRefreshed.prototype, 'bucket');
AggregateColumn({ fn: 'avg', column: 'value' })(ReadingHourlyRefreshed.prototype, 'avgValue');

// A CAGG whose refresh omits scheduleInterval → codegen defaults it to the bucket width.
class ReadingHourlyDefaultSchedule {}
ContinuousAggregate({
  name: 'reading_hourly_defsched',
  source: Reading,
  bucket: '2 hours',
  refresh: { startOffset: '7 days', endOffset: '1 hour' },
})(ReadingHourlyDefaultSchedule);
BucketColumn()(ReadingHourlyDefaultSchedule.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(ReadingHourlyDefaultSchedule.prototype, 'n');

// M2.5d — a hierarchical CAGG: a daily rollup built FROM an hourly CAGG (not the hypertable).
// The child exposes rollup-friendly aggregates (sum + count) so the parent can re-aggregate.
class ReadingHourlyRollup {}
ContinuousAggregate({ name: 'reading_hourly_rollup', source: Reading, bucket: '1 hour' })(
  ReadingHourlyRollup,
);
BucketColumn()(ReadingHourlyRollup.prototype, 'bucket');
GroupColumn()(ReadingHourlyRollup.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'value' })(ReadingHourlyRollup.prototype, 'sumValue');
AggregateColumn({ fn: 'count' })(ReadingHourlyRollup.prototype, 'samples');

class ReadingDailyRollup {}
ContinuousAggregate({ name: 'reading_daily_rollup', source: ReadingHourlyRollup, bucket: '1 day' })(
  ReadingDailyRollup,
);
BucketColumn()(ReadingDailyRollup.prototype, 'bucket');
GroupColumn()(ReadingDailyRollup.prototype, 'sensor'); // child's projected group column
AggregateColumn({ fn: 'sum', column: 'sumValue' })(ReadingDailyRollup.prototype, 'sumValue'); // roll up child sums
AggregateColumn({ fn: 'sum', column: 'samples' })(ReadingDailyRollup.prototype, 'samples'); // roll up child counts

// A circular pair (A sources B, B sources A) — must be rejected at codegen.
class CyclicA {}
class CyclicB {}
ContinuousAggregate({ name: 'cyclic_a', source: CyclicB, bucket: '1 hour' })(CyclicA);
ContinuousAggregate({ name: 'cyclic_b', source: CyclicA, bucket: '1 hour' })(CyclicB);
BucketColumn()(CyclicA.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(CyclicA.prototype, 'n');
BucketColumn()(CyclicB.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(CyclicB.prototype, 'n');

// A 3-level chain whose view names sort in the REVERSE of dependency order, so a correct
// topological sort cannot be faked by alphabetical ordering: base(zzz) → mid(mmm) → top(aaa).
class ChainBase {}
ContinuousAggregate({ name: 'zzz_chain_base', source: Reading, bucket: '1 minute' })(ChainBase);
BucketColumn()(ChainBase.prototype, 'bucket');
GroupColumn()(ChainBase.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'value' })(ChainBase.prototype, 'sum_v');

class ChainMid {}
ContinuousAggregate({ name: 'mmm_chain_mid', source: ChainBase, bucket: '1 hour' })(ChainMid);
BucketColumn()(ChainMid.prototype, 'bucket');
GroupColumn()(ChainMid.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'sum_v' })(ChainMid.prototype, 'sum_v');

class ChainTop {}
ContinuousAggregate({ name: 'aaa_chain_top', source: ChainMid, bucket: '1 day' })(ChainTop);
BucketColumn()(ChainTop.prototype, 'bucket');
GroupColumn()(ChainTop.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'sum_v' })(ChainTop.prototype, 'sum_v');

describe('generateTimescaleMigration — continuous aggregates', () => {
  it('emits CAGG DDL from decorators (after the hypertables), reversed on down', () => {
    const ds = stubDataSource([
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'sensor', databaseName: 'sensor' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [ReadingHourly],
    });
    expect(gen.up).toContain(
      'CREATE MATERIALIZED VIEW "public"."reading_hourly" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS ' +
        `SELECT time_bucket(INTERVAL '1 hour', "time") AS "bucket", "sensor", ` +
        'avg("value") AS "avgValue", count(*) AS "samples" ' +
        `FROM "public"."reading" GROUP BY time_bucket(INTERVAL '1 hour', "time"), "sensor" WITH NO DATA;`,
    );
    expect(gen.down).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly";');
  });

  it('resolves source columns via @Column({ name }) and honours materializedOnly', () => {
    const ds = stubDataSource([
      {
        target: Mapped,
        tableName: 'mapped',
        columns: [
          { propertyName: 'measuredAt', databaseName: 'measured_at' },
          { propertyName: 'reading', databaseName: 'reading_val' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [MappedDaily],
    });
    expect(gen.up).toContain(
      'CREATE MATERIALIZED VIEW "public"."mapped_daily" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = TRUE) AS ' +
        `SELECT time_bucket(INTERVAL '1 day', "measured_at") AS "day", ` +
        'sum("reading_val") AS "total" ' +
        `FROM "public"."mapped" GROUP BY time_bucket(INTERVAL '1 day', "measured_at") WITH NO DATA;`,
    );
  });

  it('rejects a non-@ContinuousAggregate class passed as a CAGG', () => {
    const ds = stubDataSource([{ target: Reading, tableName: 'reading' }]);
    expect(() =>
      generateTimescaleMigration(ds, { timestamp: TS, continuousAggregates: [Plain] }),
    ).toThrowError(TimescaleError);
  });

  it('rejects a CAGG whose source is not a registered @Hypertable entity', () => {
    // Reading is not in entityMetadatas here.
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    expect(() =>
      generateTimescaleMigration(ds, { timestamp: TS, continuousAggregates: [ReadingHourly] }),
    ).toThrowError(TimescaleError);
  });

  it('rejects more than one @BucketColumn on a continuous aggregate', () => {
    class TwoBuckets {}
    ContinuousAggregate({ name: 'two_buckets', source: Reading, bucket: '1 hour' })(TwoBuckets);
    BucketColumn()(TwoBuckets.prototype, 'a');
    expect(() => BucketColumn()(TwoBuckets.prototype, 'b')).toThrowError(TimescaleError);
  });

  it('throws NOT_A_HYPERTABLE when the source is a registered non-hypertable entity', () => {
    // Plain IS in entityMetadatas here (so the "unregistered" branch is skipped) but is
    // not decorated @Hypertable → the NOT_A_HYPERTABLE branch must fire.
    const ds = stubDataSource([{ target: Plain, tableName: 'plain' }]);
    expect(() =>
      generateTimescaleMigration(ds, { timestamp: TS, continuousAggregates: [CaggOnPlain] }),
    ).toThrowError(/not a @Hypertable/);
  });

  it('honours an explicit timeColumn override (bucketing on a non-@TimeColumn source column)', () => {
    const ds = stubDataSource([
      {
        target: Multi,
        tableName: 'multi',
        columns: [
          { propertyName: 'createdAt', databaseName: 'created_at' },
          { propertyName: 'eventTime', databaseName: 'event_time' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [MultiByEvent],
    });
    const caggStmt = gen.up.find((s) => s.includes('"public"."multi_by_event"')) ?? '';
    expect(caggStmt).toContain(`time_bucket(INTERVAL '1 hour', "event_time")`);
    // The override must win: the CAGG must NOT bucket on the source @TimeColumn's column.
    // (`created_at` still appears in Multi's own create_hypertable DDL — that's expected.)
    expect(caggStmt).not.toContain('created_at');
  });

  it('resolves a @GroupColumn through @Column({ name }) and projects the physical name', () => {
    const ds = stubDataSource([
      {
        target: Mapped,
        tableName: 'mapped',
        columns: [
          { propertyName: 'measuredAt', databaseName: 'measured_at' },
          { propertyName: 'reading', databaseName: 'reading_val' },
          { propertyName: 'deviceId', databaseName: 'device_id' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [MappedByDevice],
    });
    expect(gen.up).toContain(
      'CREATE MATERIALIZED VIEW "public"."mapped_by_device" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS ' +
        `SELECT time_bucket(INTERVAL '1 day', "measured_at") AS "day", "device_id", ` +
        'sum("reading_val") AS "total" ' +
        `FROM "public"."mapped" GROUP BY time_bucket(INTERVAL '1 day', "measured_at"), "device_id" WITH NO DATA;`,
    );
    expect(gen.up.join('\n')).not.toContain('deviceId'); // property name must not leak
  });

  it('processes multiple continuous aggregates deterministically (sorted by view name)', () => {
    const ds = stubDataSource([
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'sensor', databaseName: 'sensor' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
      {
        target: Mapped,
        tableName: 'mapped',
        columns: [
          { propertyName: 'measuredAt', databaseName: 'measured_at' },
          { propertyName: 'reading', databaseName: 'reading_val' },
        ],
      },
    ]);
    // Pass in reverse-sorted order; output must still be mapped_daily before reading_hourly.
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [ReadingHourly, MappedDaily],
    });
    const mappedIdx = gen.up.findIndex((s) => s.includes('"public"."mapped_daily"'));
    const readingIdx = gen.up.findIndex((s) => s.includes('"public"."reading_hourly"'));
    expect(mappedIdx).toBeGreaterThanOrEqual(0);
    expect(readingIdx).toBeGreaterThan(mappedIdx); // 'mapped_daily' < 'reading_hourly'
  });

  it('rejects duplicate output column names across bucket/group/aggregate', () => {
    const ds = stubDataSource([
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
    ]);
    expect(() =>
      generateTimescaleMigration(ds, { timestamp: TS, continuousAggregates: [DupCols] }),
    ).toThrowError(/duplicate output column "total"/);
  });

  it('getContinuousAggregateMeta throws for a CAGG missing its @BucketColumn', () => {
    expect(() => getContinuousAggregateMeta(NoBucket)).toThrowError(/@BucketColumn/);
  });

  it('getContinuousAggregateMeta throws for a CAGG with no @AggregateColumn', () => {
    expect(() => getContinuousAggregateMeta(NoAggregate)).toThrowError(/@AggregateColumn/);
  });

  it('getContinuousAggregateMeta returns undefined for a non-CAGG class', () => {
    expect(getContinuousAggregateMeta(Plain)).toBeUndefined();
  });

  const readingDs = (): DataSource =>
    stubDataSource([
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'sensor', databaseName: 'sensor' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
    ]);

  it('emits add_continuous_aggregate_policy after CREATE, and removes it before DROP', () => {
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingHourlyRefreshed],
    });
    const createIdx = gen.up.findIndex((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."reading_hourly_refreshed"'),
    );
    const addIdx = gen.up.findIndex((s) => s.includes('add_continuous_aggregate_policy'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(createIdx); // policy added AFTER the view exists
    expect(gen.up[addIdx]).toContain(
      `add_continuous_aggregate_policy('"public"."reading_hourly_refreshed"', ` +
        `start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', ` +
        `schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);`,
    );
    // down: remove policy BEFORE dropping the view
    const removeIdx = gen.down.findIndex((s) => s.includes('remove_continuous_aggregate_policy'));
    const dropIdx = gen.down.findIndex((s) =>
      s.includes('DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly_refreshed"'),
    );
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(removeIdx);
  });

  it('defaults schedule_interval to the bucket width when refresh omits it', () => {
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingHourlyDefaultSchedule],
    });
    const add = gen.up.find((s) => s.includes('add_continuous_aggregate_policy')) ?? '';
    // bucket is '2 hours' → schedule_interval defaults to it (always emitted for 2.18 compat)
    expect(add).toContain(`schedule_interval => INTERVAL '2 hours'`);
  });

  it('emits no refresh policy when the CAGG has no refresh option', () => {
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingHourly],
    });
    expect(gen.up.join('\n')).not.toContain('add_continuous_aggregate_policy');
    expect(gen.down.join('\n')).not.toContain('remove_continuous_aggregate_policy');
  });

  it('tears multiple CAGGs down in the exact reverse of creation order (remove before drop)', () => {
    // Sorted by view name, 'reading_hourly_defsched' is created before 'reading_hourly_refreshed'.
    // A true reverse drops 'refreshed' first; and within each CAGG the policy is removed
    // BEFORE the view is dropped (a flat reverse would wrongly invert that inner order).
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingHourlyDefaultSchedule, ReadingHourlyRefreshed],
    });
    const d = gen.down;
    const at = (needle: string, view: string): number =>
      d.findIndex((s) => s.includes(needle) && s.includes(view));
    const refreshedRemove = at('remove_continuous_aggregate_policy', 'reading_hourly_refreshed');
    const refreshedDrop = at('DROP MATERIALIZED VIEW', 'reading_hourly_refreshed');
    const defschedRemove = at('remove_continuous_aggregate_policy', 'reading_hourly_defsched');
    const defschedDrop = at('DROP MATERIALIZED VIEW', 'reading_hourly_defsched');

    expect(
      Math.min(refreshedRemove, refreshedDrop, defschedRemove, defschedDrop),
    ).toBeGreaterThanOrEqual(0);
    expect(refreshedRemove).toBeLessThan(refreshedDrop); // remove policy before DROP
    expect(defschedRemove).toBeLessThan(defschedDrop);
    expect(refreshedDrop).toBeLessThan(defschedRemove); // 'refreshed' (created last) torn down first
  });

  it('drops the continuous aggregate before the (no-op) hypertable down', () => {
    const ds = stubDataSource([
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'sensor', databaseName: 'sensor' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [ReadingHourly],
    });
    const dropIdx = gen.down.findIndex((s) =>
      s.includes('DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly"'),
    );
    const noticeIdx = gen.down.findIndex((s) => s.includes('RAISE NOTICE'));
    expect(dropIdx).toBe(0);
    expect(noticeIdx).toBeGreaterThan(dropIdx);
  });

  it('builds a hierarchical CAGG that selects FROM the child CAGG view', () => {
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingDailyRollup, ReadingHourlyRollup],
    });
    const parent = gen.up.find((s) => s.includes('"public"."reading_daily_rollup"')) ?? '';
    expect(parent).toContain('CREATE MATERIALIZED VIEW "public"."reading_daily_rollup"');
    // buckets on the child's @BucketColumn output, FROM the child's view (not the hypertable)
    expect(parent).toContain(`time_bucket(INTERVAL '1 day', "bucket")`);
    expect(parent).toContain('FROM "public"."reading_hourly_rollup"');
    // rolls up the child's output columns verbatim (identity resolution — no @Column remap)
    expect(parent).toContain('sum("sumValue") AS "sumValue"');
    expect(parent).toContain('sum("samples") AS "samples"');
    expect(parent).toContain('"sensor"'); // grouped child column
  });

  it('creates the child CAGG before its parent even when the parent sorts first alphabetically', () => {
    // 'reading_daily_rollup' < 'reading_hourly_rollup' alphabetically, so a naive sort would
    // emit the parent first; topological ordering must still create the child (hourly) first.
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingDailyRollup, ReadingHourlyRollup],
    });
    const childCreate = gen.up.findIndex((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."reading_hourly_rollup"'),
    );
    const parentCreate = gen.up.findIndex((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."reading_daily_rollup"'),
    );
    expect(childCreate).toBeGreaterThanOrEqual(0);
    expect(childCreate).toBeLessThan(parentCreate);
    // down drops the parent before the child
    const childDrop = gen.down.findIndex((s) => s.includes('"public"."reading_hourly_rollup"'));
    const parentDrop = gen.down.findIndex((s) => s.includes('"public"."reading_daily_rollup"'));
    expect(parentDrop).toBeLessThan(childDrop);
  });

  it('resolves a CAGG source not in the set (cross-migration parent) without ordering', () => {
    // Only the parent is passed; its child CAGG already exists from an earlier migration.
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingDailyRollup],
    });
    const parent = gen.up.find((s) => s.includes('"public"."reading_daily_rollup"')) ?? '';
    expect(parent).toContain('FROM "public"."reading_hourly_rollup"');
    // the child is NOT (re)created in this migration
    expect(
      gen.up.some((s) => s.includes('CREATE MATERIALIZED VIEW "public"."reading_hourly_rollup"')),
    ).toBe(false);
  });

  it('rejects a circular source dependency between continuous aggregates', () => {
    expect(() =>
      generateTimescaleMigration(readingDs(), {
        timestamp: TS,
        continuousAggregates: [CyclicA, CyclicB],
      }),
    ).toThrowError(/circular/);
  });

  it('orders an N-level CAGG chain by dependency, not alphabetically', () => {
    // View names sort top < mid < base, the reverse of the base → mid → top dependency.
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ChainTop, ChainMid, ChainBase], // deliberately unsorted
    });
    const up = (v: string): number =>
      gen.up.findIndex((s) => s.includes(`CREATE MATERIALIZED VIEW "public"."${v}"`));
    expect(up('zzz_chain_base')).toBeGreaterThanOrEqual(0);
    expect(up('zzz_chain_base')).toBeLessThan(up('mmm_chain_mid')); // base before mid
    expect(up('mmm_chain_mid')).toBeLessThan(up('aaa_chain_top')); // mid before top
    // down is the strict reverse: top dropped first, base last
    const down = (v: string): number => gen.down.findIndex((s) => s.includes(`"public"."${v}"`));
    expect(down('aaa_chain_top')).toBeLessThan(down('mmm_chain_mid'));
    expect(down('mmm_chain_mid')).toBeLessThan(down('zzz_chain_base'));
  });

  it('dedupes a continuous aggregate passed more than once (no double create, no false cycle)', () => {
    const gen = generateTimescaleMigration(readingDs(), {
      timestamp: TS,
      continuousAggregates: [ReadingHourlyRollup, ReadingHourlyRollup],
    });
    const creates = gen.up.filter((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."reading_hourly_rollup"'),
    );
    expect(creates).toHaveLength(1);
  });

  // M4.1 S2 — byte-identical golden lock. generateTimescaleMigration now routes every statement
  // through the core Operation IR + compileOperation(s) choke point instead of calling the builders
  // directly. This pins the COMPLETE assembled up/down (hypertable → columnstore → retention, then
  // CAGG + refresh policy; reversed on down) so the IR routing is provably output-preserving.
  it('produces byte-identical full up/down through the operation IR (golden)', () => {
    const ds = stubDataSource([
      {
        target: Trade,
        tableName: 'trades',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'symbol', databaseName: 'symbol' },
        ],
      },
      {
        target: Reading,
        tableName: 'reading',
        columns: [
          { propertyName: 'time', databaseName: 'time' },
          { propertyName: 'sensor', databaseName: 'sensor' },
          { propertyName: 'value', databaseName: 'value' },
        ],
      },
    ]);
    const gen = generateTimescaleMigration(ds, {
      timestamp: TS,
      continuousAggregates: [ReadingHourlyRefreshed],
    });

    expect(gen.up).toEqual([
      // 'reading' sorts before 'trades' → its hypertable DDL comes first.
      `SELECT create_hypertable('"public"."reading"', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => FALSE);`,
      `SELECT create_hypertable('"public"."trades"', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => FALSE);`,
      `ALTER TABLE "public"."trades" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"symbol"', timescaledb.orderby = '"time" DESC');`,
      `CALL add_columnstore_policy('"public"."trades"', after => INTERVAL '7 days', if_not_exists => TRUE);`,
      `SELECT add_retention_policy('"public"."trades"', drop_after => INTERVAL '90 days', if_not_exists => TRUE);`,
      // CAGGs after the hypertables: CREATE then add-policy.
      'CREATE MATERIALIZED VIEW "public"."reading_hourly_refreshed" ' +
        'WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS ' +
        `SELECT time_bucket(INTERVAL '1 hour', "time") AS "bucket", avg("value") AS "avgValue" ` +
        `FROM "public"."reading" GROUP BY time_bucket(INTERVAL '1 hour', "time") WITH NO DATA;`,
      `SELECT add_continuous_aggregate_policy('"public"."reading_hourly_refreshed"', ` +
        `start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', ` +
        `schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);`,
    ]);

    // The non-destructive hypertable-down NOTICE, reconstructed independently from the builder's
    // format (nonDestructiveNotice) so the golden byte-locks the FULL string, not a self-reference.
    const htNotice = (ident: string): string =>
      `DO $$ BEGIN RAISE NOTICE 'timescaledb: not reverting hypertable on % — reverting would lose data (non-destructive down)', '${ident}'; END $$;`;
    expect(gen.down).toEqual([
      // CAGG teardown is unshifted to the front (remove policy before DROP).
      `SELECT remove_continuous_aggregate_policy('"public"."reading_hourly_refreshed"', if_exists => TRUE);`,
      `DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly_refreshed";`,
      // Then the hypertable downs in ENTITY order (reading before trades); each entity's own
      // statements are reversed. reading has only its non-destructive hypertable notice.
      htNotice('"public"."reading"'),
      // trades' statements reversed: retention, then columnstore, then its hypertable notice.
      `SELECT remove_retention_policy('"public"."trades"', if_exists => TRUE);`,
      `CALL remove_columnstore_policy('"public"."trades"', if_exists => TRUE);`,
      htNotice('"public"."trades"'),
    ]);
    expect(gen.down).toHaveLength(6);
  });
});
