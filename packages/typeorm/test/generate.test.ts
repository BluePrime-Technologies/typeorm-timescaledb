import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner } from 'typeorm';
import {
  generateTimescaleMigration,
  renderTimescaleMigration,
  createTimescaleMigration,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
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

/** Build a stub DataSource exposing only entityMetadatas (no DB connection needed). */
function stubDataSource(entities: StubEntity[]): DataSource {
  return {
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
