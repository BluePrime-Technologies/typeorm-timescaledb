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

class Plain {}

/** Build a stub DataSource exposing only entityMetadatas (no DB connection needed). */
function stubDataSource(
  entities: Array<{ target: unknown; tableName: string; schema?: string }>,
): DataSource {
  return { entityMetadatas: entities } as unknown as DataSource;
}

describe('generateTimescaleMigration', () => {
  it('emits hypertable → columnstore → retention in up, and the reverse in down', () => {
    const ds = stubDataSource([{ target: Trade, tableName: 'trades' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1700000000000 });

    expect(gen.name).toBe('Timescale1700000000000');
    expect(gen.timestamp).toBe(1700000000000);
    expect(gen.up).toEqual([
      `SELECT create_hypertable('"public"."trades"', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => FALSE);`,
      `ALTER TABLE "public"."trades" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"symbol"', timescaledb.orderby = '"time" DESC');`,
      `CALL add_columnstore_policy('"public"."trades"', after => INTERVAL '7 days', if_not_exists => TRUE);`,
      `SELECT add_retention_policy('"public"."trades"', drop_after => INTERVAL '90 days', if_not_exists => TRUE);`,
    ]);
    // down is the reverse: retention, then columnstore policy, then the hypertable notice
    expect(gen.down[0]).toBe(
      `SELECT remove_retention_policy('"public"."trades"', if_exists => TRUE);`,
    );
    expect(gen.down[1]).toBe(
      `CALL remove_columnstore_policy('"public"."trades"', if_exists => TRUE);`,
    );
    expect(gen.down[2]).toContain('RAISE NOTICE');
    expect(gen.down).toHaveLength(3);
  });

  it('skips non-hypertable entities', () => {
    const ds = stubDataSource([
      { target: Plain, tableName: 'plain' },
      { target: Event, tableName: 'events' },
    ]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1 });
    expect(gen.up.join('\n')).not.toContain('plain');
    expect(gen.up.join('\n')).toContain('"public"."events"');
  });

  it('processes entities deterministically (sorted by table name)', () => {
    const ds = stubDataSource([
      { target: Trade, tableName: 'trades' },
      { target: Event, tableName: 'events' },
    ]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1 });
    const firstEvents = gen.up.findIndex((s) => s.includes('"events"'));
    const firstTrades = gen.up.findIndex((s) => s.includes('"trades"'));
    expect(firstEvents).toBeLessThan(firstTrades); // 'events' < 'trades'
  });

  it('honors a non-default schema', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events', schema: 'analytics' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1 });
    expect(gen.up[0]).toContain(`create_hypertable('"analytics"."events"'`);
  });

  it('supports a custom name prefix and rejects an invalid one', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    expect(generateTimescaleMigration(ds, { name: 'InitHypertables', timestamp: 5 }).name).toBe(
      'InitHypertables5',
    );
    expect(() => generateTimescaleMigration(ds, { name: '9 bad-name' })).toThrow(TimescaleError);
  });

  it('returns empty statement lists when there are no hypertables', () => {
    const gen = generateTimescaleMigration(stubDataSource([{ target: Plain, tableName: 'p' }]), {
      timestamp: 1,
    });
    expect(gen.up).toEqual([]);
    expect(gen.down).toEqual([]);
  });
});

describe('renderTimescaleMigration', () => {
  it('renders a valid TypeORM migration class with one query() per statement', () => {
    const ds = stubDataSource([{ target: Event, tableName: 'events' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1700000000000 });
    const src = renderTimescaleMigration(gen);

    expect(src).toContain("import { MigrationInterface, QueryRunner } from 'typeorm';");
    expect(src).toContain('export class Timescale1700000000000 implements MigrationInterface {');
    expect(src).toContain("name = 'Timescale1700000000000';");
    expect(src).toContain('public async up(queryRunner: QueryRunner): Promise<void> {');
    // each statement is embedded via JSON.stringify (safe escaping)
    for (const sql of gen.up) {
      expect(src).toContain(`await queryRunner.query(${JSON.stringify(sql)});`);
    }
  });

  it('renders a no-op body when there is nothing to do', () => {
    const gen = generateTimescaleMigration(stubDataSource([]), { timestamp: 1 });
    expect(renderTimescaleMigration(gen)).toContain('// no-op');
  });
});

describe('createTimescaleMigration', () => {
  it('runs each statement in order against a query runner', async () => {
    const ds = stubDataSource([{ target: Trade, tableName: 'trades' }]);
    const gen = generateTimescaleMigration(ds, { timestamp: 1 });
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

    expect(migration.name).toBe('Timescale1');
  });
});
