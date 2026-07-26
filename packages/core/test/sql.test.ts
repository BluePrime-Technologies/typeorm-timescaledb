import { describe, expect, it } from 'vitest';
import {
  addColumnstorePolicySQL,
  addRetentionPolicySQL,
  alterColumnstoreConfigSQL,
  alterCompressionPolicySQL,
  alterRetentionPolicySQL,
  createHypertableSQL,
  renameHypertableSQL,
  TimescaleError,
  TimescaleErrorCode,
  type MigrationStatement,
} from '../src/index.js';

/** Join atomic statements for substring assertions. */
const upSql = (s: MigrationStatement): string => s.up.join('\n');
const downSql = (s: MigrationStatement): string => s.down.join('\n');

/** A migration `down()` must never destroy data. */
const DESTRUCTIVE = /\b(drop|truncate|delete)\b|drop_chunks/i;
function expectNonDestructiveDown(stmt: MigrationStatement): void {
  expect(downSql(stmt)).not.toMatch(DESTRUCTIVE);
}

describe('createHypertableSQL', () => {
  it('emits the modern by_range dimension-builder form, idempotent by default', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      chunkInterval: '7 days',
    });
    expect(s.up).toEqual([
      `SELECT create_hypertable('"public"."metrics"', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => FALSE);`,
    ]);
  });

  it('omits the interval when chunkInterval is not given (TSDB default)', () => {
    const s = createHypertableSQL({ table: 'metrics', timeColumn: 'time' });
    expect(upSql(s)).toContain(`by_range('time')`);
    expect(upSql(s)).not.toContain('INTERVAL');
  });

  it('honors schema qualification and quotes identifiers', () => {
    const s = createHypertableSQL({
      table: 'analytics.events',
      timeColumn: 'ts',
      chunkInterval: '1 day',
    });
    expect(upSql(s)).toContain(`create_hypertable('"analytics"."events"'`);
    expect(s.inspect).toContain(`hypertable_schema = 'analytics'`);
    expect(s.inspect).toContain(`hypertable_name = 'events'`);
  });

  it('preserves the case of mixed-case identifiers (why quoting matters)', () => {
    const s = createHypertableSQL({ table: 'Analytics.Events', timeColumn: 'EventTime' });
    // without quoting, Postgres would fold these to lowercase and miss the table
    expect(upSql(s)).toContain(`create_hypertable('"Analytics"."Events"', by_range('EventTime')`);
    expect(s.inspect).toContain(`hypertable_schema = 'Analytics'`);
    expect(s.inspect).toContain(`hypertable_name = 'Events'`);
  });

  it('adds a hash dimension for space partitioning as a separate atomic statement', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      chunkInterval: '1 day',
      spacePartition: { column: 'device_id', partitions: 4 },
    });
    expect(s.up).toHaveLength(2);
    expect(s.up[1]).toBe(
      `SELECT add_dimension('"public"."metrics"', by_hash('device_id', 4), if_not_exists => TRUE);`,
    );
  });

  it('can disable idempotency / enable data migration', () => {
    const s = createHypertableSQL({
      table: 'metrics',
      timeColumn: 'time',
      ifNotExists: false,
      migrateData: true,
    });
    expect(upSql(s)).toContain('if_not_exists => FALSE');
    expect(upSql(s)).toContain('migrate_data => TRUE');
  });

  it('down is a non-destructive no-op (NOTICE only)', () => {
    const s = createHypertableSQL({ table: 'metrics', timeColumn: 'time' });
    expect(downSql(s)).toContain('RAISE NOTICE');
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

  it('rejects a zero chunk interval (TimescaleDB requires a positive range interval)', () => {
    for (const bad of ['0 days', '0 hours', '00 seconds']) {
      try {
        createHypertableSQL({ table: 'metrics', timeColumn: 'time', chunkInterval: bad });
        throw new Error(`expected throw for ${bad}`);
      } catch (e) {
        expect((e as InstanceType<typeof TimescaleError>).code).toBe(
          TimescaleErrorCode.INVALID_ARGUMENT,
        );
      }
    }
  });

  it('rejects spacePartition combined with migrateData (add_dimension needs an empty table)', () => {
    expect(() =>
      createHypertableSQL({
        table: 'metrics',
        timeColumn: 'time',
        migrateData: true,
        spacePartition: { column: 'device_id', partitions: 4 },
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
    expect(s.up).toHaveLength(2);
    expect(s.up[0]).toBe(
      `ALTER TABLE "public"."metrics" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"device_id"', timescaledb.orderby = '"time" DESC');`,
    );
    expect(s.up[1]).toBe(
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
    expect(upSql(s)).toContain(`timescaledb.segmentby = '"a", "b"'`);
    expect(upSql(s)).toContain(`timescaledb.orderby = '"time" ASC, "seq" DESC'`);
  });

  it('quotes mixed-case columns inside the reloptions (preserves case)', () => {
    const s = addColumnstorePolicySQL({
      table: 'metrics',
      segmentBy: ['AssetId'],
      orderBy: [{ column: 'EventTime', direction: 'DESC' }],
      after: '1 day',
    });
    expect(upSql(s)).toContain(`timescaledb.segmentby = '"AssetId"'`);
    expect(upSql(s)).toContain(`timescaledb.orderby = '"EventTime" DESC'`);
  });

  it('enables the columnstore without a policy when after is omitted', () => {
    const s = addColumnstorePolicySQL({ table: 'metrics', segmentBy: ['device_id'] });
    expect(s.up).toHaveLength(1);
    expect(upSql(s)).toContain('enable_columnstore = true');
    expect(upSql(s)).not.toContain('add_columnstore_policy');
    expect(downSql(s)).toContain('RAISE NOTICE'); // nothing to safely reverse
  });

  it('down removes the policy (non-destructive) and never disables the columnstore', () => {
    const s = addColumnstorePolicySQL({ table: 'metrics', after: '7 days' });
    expect(s.down).toEqual([
      `CALL remove_columnstore_policy('"public"."metrics"', if_exists => TRUE);`,
    ]);
    expect(downSql(s)).not.toContain('enable_columnstore');
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

  it('rejects an orderBy direction outside the ASC/DESC allow-list (runtime any-caller)', () => {
    expect(() =>
      addColumnstorePolicySQL({
        table: 'metrics',
        // a JS/any caller can pass an arbitrary direction despite the 'ASC'|'DESC' type
        orderBy: [{ column: 'time', direction: 'DESC; DROP' as unknown as 'ASC' }],
      }),
    ).toThrowError(/ASC.*DESC/);
  });
});

describe('addRetentionPolicySQL', () => {
  it('adds a retention policy, idempotent by default', () => {
    const s = addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days' });
    expect(s.up).toEqual([
      `SELECT add_retention_policy('"public"."metrics"', drop_after => INTERVAL '90 days', if_not_exists => TRUE);`,
    ]);
  });

  it('down removes the policy (never deletes data)', () => {
    const s = addRetentionPolicySQL({ table: 'metrics', dropAfter: '90 days' });
    expect(s.down).toEqual([
      `SELECT remove_retention_policy('"public"."metrics"', if_exists => TRUE);`,
    ]);
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

describe('renameHypertableSQL', () => {
  it('renames the table; down renames back (losslessly reversible)', () => {
    const s = renameHypertableSQL({ from: 'old_metrics', to: 'metrics' });
    expect(s.up).toEqual([`ALTER TABLE "public"."old_metrics" RENAME TO "metrics";`]);
    expect(s.down).toEqual([`ALTER TABLE "public"."metrics" RENAME TO "old_metrics";`]);
  });

  it('is schema-qualification-aware', () => {
    const s = renameHypertableSQL({ from: 'analytics.old_events', to: 'analytics.events' });
    expect(s.up).toEqual([`ALTER TABLE "analytics"."old_events" RENAME TO "events";`]);
    expect(s.down).toEqual([`ALTER TABLE "analytics"."events" RENAME TO "old_events";`]);
  });

  it('inspect targets the new (after) table name', () => {
    const s = renameHypertableSQL({ from: 'old_metrics', to: 'metrics' });
    expect(s.inspect).toContain(`hypertable_name = 'metrics'`);
    expect(s.inspect).toContain(`hypertable_schema = 'public'`);
  });

  it('rejects a cross-schema rename (needs SET SCHEMA, which this does not emit)', () => {
    expect(() => renameHypertableSQL({ from: 'public.metrics', to: 'analytics.metrics' })).toThrow(
      TimescaleError,
    );
  });

  it('rejects a no-op rename (from === to)', () => {
    expect(() => renameHypertableSQL({ from: 'metrics', to: 'metrics' })).toThrow(TimescaleError);
    expect(() => renameHypertableSQL({ from: 'public.metrics', to: 'metrics' })).toThrow(
      TimescaleError,
    );
  });

  it('rejects unsafe identifiers', () => {
    expect(() =>
      renameHypertableSQL({ from: 'metrics', to: 'metrics"; DROP TABLE x; --' }),
    ).toThrow(TimescaleError);
    expect(() => renameHypertableSQL({ from: 'a.b.c', to: 'metrics' })).toThrow(TimescaleError);
  });

  it('down is non-destructive (renames back, never drops)', () => {
    expectNonDestructiveDown(renameHypertableSQL({ from: 'old_m', to: 'm' }));
  });
});

describe('atomic statements + non-destructive down() gate (all builders)', () => {
  it('every up/down entry is a single statement (no embedded newlines)', () => {
    const all: MigrationStatement[] = [
      createHypertableSQL({
        table: 'm',
        timeColumn: 't',
        chunkInterval: '1 day',
        spacePartition: { column: 'd', partitions: 2 },
      }),
      addColumnstorePolicySQL({ table: 'm', segmentBy: ['d'], after: '1 day' }),
      addRetentionPolicySQL({ table: 'm', dropAfter: '1 day' }),
    ];
    for (const s of all) {
      for (const stmt of [...s.up, ...s.down]) {
        expect(stmt).not.toContain('\n');
        expect(stmt.trim().endsWith(';')).toBe(true);
      }
    }
  });

  it('no builder emits a destructive statement in down()', () => {
    expectNonDestructiveDown(createHypertableSQL({ table: 'm', timeColumn: 't' }));
    expectNonDestructiveDown(addColumnstorePolicySQL({ table: 'm', after: '1 day' }));
    expectNonDestructiveDown(addColumnstorePolicySQL({ table: 'm', segmentBy: ['a'] }));
    expectNonDestructiveDown(addRetentionPolicySQL({ table: 'm', dropAfter: '1 day' }));
    expectNonDestructiveDown(renameHypertableSQL({ from: 'old_m', to: 'm' }));
  });
});

// ── Pre-release audit regressions (core SQL builders) ──────────────────────────────────────────
describe('core SQL builders — audit regressions', () => {
  it('uses a named dollar-quote tag so a $$ in an identifier cannot close the DO block', () => {
    // `$` is a legal identifier char and passes the allow-list, so `a$$b` rendered a `$$` INSIDE
    // `DO $$ ... $$`. Postgres closes the body at that first `$$`, making the down() a syntax error.
    const stmt = createHypertableSQL({ table: 'a$$b', timeColumn: 'ts' });
    const down = stmt.down.join('\n');
    expect(down).toContain('$tsdb_notice$');
    // the body must not be terminated early: exactly the opening and closing tag, nothing between
    expect(down.split('$tsdb_notice$')).toHaveLength(3);
    expect(down.startsWith('DO $tsdb_notice$')).toBe(true);
    expect(down.trimEnd().endsWith('$tsdb_notice$;')).toBe(true);
  });

  it('rejects a NEGATIVE threshold in a policy alter (would drop the whole hypertable)', () => {
    // add_retention_policy(drop_after => INTERVAL '-30 days') is accepted by TimescaleDB and drops
    // every chunk older than now() + 30 days — i.e. everything — on the next job run.
    expect(() =>
      alterRetentionPolicySQL({ table: 'public.m', from: '90 days', to: '-30 days' }),
    ).toThrow(TimescaleError);
    expect(() =>
      alterCompressionPolicySQL({ table: 'public.m', from: '7 days', to: '-1 day' }),
    ).toThrow(TimescaleError);
    // and a zero threshold is equally meaningless
    expect(() =>
      alterRetentionPolicySQL({ table: 'public.m', from: '90 days', to: '0 days' }),
    ).toThrow(TimescaleError);
  });

  it('preserves a customized schedule_interval across a remove-then-add policy alter', () => {
    // The alter recreates the job, which otherwise resets a cadence the user set via alter_job —
    // silently, and irreversibly (down re-added with the default too).
    const stmt = alterRetentionPolicySQL({
      table: 'public.m',
      from: '90 days',
      to: '30 days',
      scheduleInterval: '12 hours',
    });
    expect(stmt.up.join('\n')).toContain("schedule_interval => INTERVAL '12 hours'");
    expect(stmt.down.join('\n')).toContain("schedule_interval => INTERVAL '12 hours'");
  });

  it('omits schedule_interval entirely when the caller does not supply one', () => {
    const stmt = alterRetentionPolicySQL({ table: 'public.m', from: '90 days', to: '30 days' });
    expect(stmt.up.join('\n')).not.toContain('schedule_interval');
  });

  it('refuses to CLEAR a columnstore facet (ALTER ... SET is additive, so it would silently persist)', () => {
    expect(() =>
      alterColumnstoreConfigSQL({
        table: 'public.m',
        from: { segmentBy: ['a'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
        to: { segmentBy: ['a'], orderBy: [] },
      }),
    ).toThrow(/cannot clear "orderBy"/);
  });

  it('inspect reports order DIRECTION, not just the column names', () => {
    const stmt = alterColumnstoreConfigSQL({
      table: 'public.m',
      from: { segmentBy: ['a'], orderBy: [{ column: 'ts', direction: 'ASC' }] },
      to: { segmentBy: ['a'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
    });
    expect(stmt.inspect).toContain('orderby_desc');
  });
});
