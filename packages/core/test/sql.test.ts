import { describe, expect, it } from 'vitest';
import {
  addColumnstorePolicySQL,
  addRetentionPolicySQL,
  createHypertableSQL,
  TimescaleError,
  TimescaleErrorCode,
  type MigrationStatement,
} from '../src/index.js';

/** A migration `down()` must never destroy data. */
const DESTRUCTIVE = /\b(drop|truncate|delete)\b|drop_chunks/i;
function expectNonDestructiveDown(stmt: MigrationStatement): void {
  expect(stmt.down).not.toMatch(DESTRUCTIVE);
}

describe('createHypertableSQL', () => {
  it('emits the modern by_range dimension-builder form, idempotent by default', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      chunkInterval: '7 days',
    });
    expect(s.up).toBe(
      `SELECT create_hypertable('"public"."metrics"', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => FALSE);`,
    );
  });

  it('omits the interval when chunkInterval is not given (TSDB default)', () => {
    const s = createHypertableSQL({ table: 'metrics', timeColumn: 'time' });
    expect(s.up).toContain(`by_range('time')`);
    expect(s.up).not.toContain('INTERVAL');
  });

  it('honors schema qualification and quotes identifiers', () => {
    const s = createHypertableSQL({
      table: 'analytics.events',
      timeColumn: 'ts',
      chunkInterval: '1 day',
    });
    expect(s.up).toContain(`create_hypertable('"analytics"."events"'`);
    expect(s.inspect).toContain(`hypertable_schema = 'analytics'`);
    expect(s.inspect).toContain(`hypertable_name = 'events'`);
  });

  it('preserves the case of mixed-case identifiers (why quoting matters)', () => {
    const s = createHypertableSQL({ table: 'Analytics.Events', timeColumn: 'EventTime' });
    // without quoting, Postgres would fold these to lowercase and miss the table
    expect(s.up).toContain(`create_hypertable('"Analytics"."Events"', by_range('EventTime')`);
    expect(s.inspect).toContain(`hypertable_schema = 'Analytics'`);
    expect(s.inspect).toContain(`hypertable_name = 'Events'`);
  });

  it('adds a hash dimension for space partitioning', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      chunkInterval: '1 day',
      spacePartition: { column: 'device_id', partitions: 4 },
    });
    expect(s.up).toContain(
      `add_dimension('"public"."metrics"', by_hash('device_id', 4), if_not_exists => TRUE);`,
    );
  });

  it('can disable idempotency / enable data migration', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      ifNotExists: false,
      migrateData: true,
    });
    expect(s.up).toContain('if_not_exists => FALSE');
    expect(s.up).toContain('migrate_data => TRUE');
  });

  it('down is a non-destructive no-op (NOTICE only)', () => {
    const s = createHypertableSQL({ table: 'metrics', timeColumn: 'time' });
    expect(s.down).toContain('RAISE NOTICE');
    expectNonDestructiveDown(s);
  });

  it('rejects unsafe identifiers (injection)', () => {
    expect(() =>
      createHypertableSQL({ table: 'metrics', timeColumn: 'time"; DROP TABLE x; --' }),
    ).toThrow(TimescaleError);
    expect(() => createHypertableSQL({ table: 'a.b.c', timeColumn: 'time' })).toThrow(
      TimescaleError,
    );
  });

  it('rejects a bad chunk interval', () => {
    try {
      createHypertableSQL({ table: 'metrics', timeColumn: 'time', chunkInterval: 'soon' });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
    }
  });

  it('rejects a non-positive partition count', () => {
    expect(() =>
      createHypertableSQL({
        table: 'metrics',
        timeColumn: 'time',
        spacePartition: { column: 'device_id', partitions: 0 },
      }),
    ).toThrow(TimescaleError);
  });
});

describe('addColumnstorePolicySQL', () => {
  it('enables the columnstore with segmentby/orderby and adds a policy', () => {
    const s = addColumnstorePolicySQL({
      table: 'metrics',
      segmentBy: ['device_id'],
      orderBy: [{ column: 'time', direction: 'DESC' }],
      after: '7 days',
    });
    expect(s.up).toContain(
      `ALTER TABLE "public"."metrics" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'device_id', timescaledb.orderby = 'time DESC');`,
    );
    expect(s.up).toContain(
      `CALL add_columnstore_policy('"public"."metrics"', after => INTERVAL '7 days', if_not_exists => TRUE);`,
    );
  });

  it('defaults orderBy direction to ASC and supports multiple columns', () => {
    const s = addColumnstorePolicySQL({
      table: 'metrics',
      segmentBy: ['a', 'b'],
      orderBy: [{ column: 'time' }, { column: 'seq', direction: 'DESC' }],
      after: '1 day',
    });
    expect(s.up).toContain(`timescaledb.segmentby = 'a, b'`);
    expect(s.up).toContain(`timescaledb.orderby = 'time ASC, seq DESC'`);
  });

  it('enables the columnstore without a policy when after is omitted', () => {
    const s = addColumnstorePolicySQL({ table: 'metrics', segmentBy: ['device_id'] });
    expect(s.up).toContain('enable_columnstore = true');
    expect(s.up).not.toContain('add_columnstore_policy');
    expect(s.down).toContain('RAISE NOTICE'); // nothing to safely reverse
  });

  it('down removes the policy (non-destructive) and never disables the columnstore', () => {
    const s = addColumnstorePolicySQL({ table: 'metrics', after: '7 days' });
    expect(s.down).toBe(`CALL remove_columnstore_policy('"public"."metrics"', if_exists => TRUE);`);
    expect(s.down).not.toContain('enable_columnstore');
    expectNonDestructiveDown(s);
  });

  it('rejects unsafe segmentby/orderby identifiers', () => {
    expect(() =>
      addColumnstorePolicySQL({ table: 'metrics', segmentBy: ['a"; DROP'], after: '1 day' }),
    ).toThrow(TimescaleError);
    expect(() =>
      addColumnstorePolicySQL({ table: 'metrics', orderBy: [{ column: 'x)' }], after: '1 day' }),
    ).toThrow(TimescaleError);
  });
});

describe('addRetentionPolicySQL', () => {
  it('adds a retention policy, idempotent by default', () => {
    const s = addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days' });
    expect(s.up).toBe(
      `SELECT add_retention_policy('"public"."metrics"', drop_after => INTERVAL '90 days', if_not_exists => TRUE);`,
    );
  });

  it('down removes the policy (never deletes data)', () => {
    const s = addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days' });
    expect(s.down).toBe(`SELECT remove_retention_policy('"public"."metrics"', if_exists => TRUE);`);
    expectNonDestructiveDown(s);
  });

  it('inspect targets the retention job', () => {
    const s = addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days' });
    expect(s.inspect).toContain("proc_name = 'policy_retention'");
    expect(s.inspect).toContain(`hypertable_name = 'metrics'`);
  });

  it('rejects a bad interval', () => {
    expect(() =>
      addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days; DROP TABLE x' }),
    ).toThrow(TimescaleError);
  });
});

describe('non-destructive down() gate (all builders)', () => {
  it('no builder emits a destructive statement in down()', () => {
    expectNonDestructiveDown(createHypertableSQL({ table: 'm', timeColumn: 't' }));
    expectNonDestructiveDown(addColumnstorePolicySQL({ table: 'm', after: '1 day' }));
    expectNonDestructiveDown(addColumnstorePolicySQL({ table: 'm', segmentBy: ['a'] }));
    expectNonDestructiveDown(addRetentionPolicySQL({ table: 'm', dropAfter: '1 day' }));
  });
});
