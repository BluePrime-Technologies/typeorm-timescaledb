import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { parseArgs, CliError, pushCommand, type Logger } from '../src/cli/index.js';
import {
  pushSchema,
  applyDirect,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
} from '../src/index.js';
import { classifyOperation } from '@blueprime/timescaledb-core';

/**
 * `push` argument contract. The load-bearing property is that the DESTRUCTIVE direction is the one
 * you must ask for: no flag combination should ever converge a database implicitly.
 */
describe('push — CLI argument contract', () => {
  it('previews by default: `apply` is false unless --apply is passed', () => {
    const a = parseArgs(['push', '-d', 'ds.ts']);
    expect(a.command).toBe('push');
    expect(a.apply).toBe(false);
    expect(a.allowDrops).toBe(false);
    expect(a.allowRefused).toBe(false);
  });

  it('sets apply only for --apply', () => {
    expect(parseArgs(['push', '-d', 'ds.ts', '--apply']).apply).toBe(true);
  });

  it('keeps the two opt-in gates independent', () => {
    // A reversible policy removal and a refuse-by-default operation are different risks; granting
    // one must never grant the other.
    const drops = parseArgs(['push', '-d', 'ds.ts', '--allow-drops']);
    expect(drops.allowDrops).toBe(true);
    expect(drops.allowRefused).toBe(false);

    const refused = parseArgs(['push', '-d', 'ds.ts', '--allow-refused']);
    expect(refused.allowRefused).toBe(true);
    expect(refused.allowDrops).toBe(false);

    const both = parseArgs(['push', '-d', 'ds.ts', '--allow-drops', '--allow-refused', '--apply']);
    expect([both.allowDrops, both.allowRefused, both.apply]).toEqual([true, true, true]);
  });

  it('does NOT swallow the following token as a boolean flag value', () => {
    // `--apply -d ds.ts` must not read `-d` as the value of `--apply`.
    const a = parseArgs(['push', '--apply', '-d', 'ds.ts']);
    expect(a.apply).toBe(true);
    expect(a.dataSource).toBe('ds.ts');
  });

  it('rejects a value passed to a boolean flag', () => {
    expect(() => parseArgs(['push', '-d', 'ds.ts', '--apply=true'])).toThrow(CliError);
  });

  it('rejects push-only flags on another verb instead of ignoring them', () => {
    // Silently ignoring them would let someone believe they had authorized something they had not.
    for (const flag of ['--apply', '--allow-drops', '--allow-refused']) {
      expect(() => parseArgs(['check', '-d', 'ds.ts', flag])).toThrow(/only valid for 'push'/);
    }
  });

  it('still accepts the pre-existing verbs and options unchanged', () => {
    expect(parseArgs(['generate', '-d', 'ds.ts', '--output', 'sql']).output).toBe('sql');
    expect(parseArgs(['check', '-d', 'ds.ts']).command).toBe('check');
  });
});

describe('pushSchema — preview vs apply', () => {
  /** A DataSource stub that records whether ANY query ran, so "preview mutates nothing" is provable. */
  function stubDs(hypertables: string[] = []): { ds: DataSource; queries: string[] } {
    const queries: string[] = [];
    const rows = (sql: string): unknown[] => {
      if (sql.includes('pg_extension')) return [{ extversion: '2.18.0' }];
      if (sql.includes('timescaledb_information.hypertables') && sql.includes('ORDER BY'))
        return hypertables.map((h) => ({
          hypertable_schema: h.split('.')[0],
          hypertable_name: h.split('.')[1],
        }));
      return [];
    };
    const runner = {
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
      get isTransactionActive() {
        return false;
      },
      query: async (sql: string) => {
        queries.push(sql);
        return rows(sql);
      },
    };
    const ds = {
      isInitialized: true,
      options: {},
      entityMetadatas: [{ target: Metric, tableName: 'metric', columns: [] }],
      createQueryRunner: () => runner,
    } as unknown as DataSource;
    return { ds, queries };
  }

  class Metric {}
  Hypertable({ chunkInterval: '1 day' })(Metric);
  TimeColumn()(Metric.prototype, 'ts');
  HypertablePrimaryKey()(Metric.prototype, 'ts');

  it('computes drift but writes NOTHING without apply', async () => {
    const { ds, queries } = stubDs(); // DB has no hypertables -> the entity is drift
    const result = await pushSchema(ds);

    expect(result.plan.steps.length).toBeGreaterThan(0); // drift detected
    expect(result.applied).toBe(false);
    expect(result.statements).toEqual([]);
    // every query issued was a READ; nothing mutating was sent
    expect(queries.some((q) => /create_hypertable|add_retention|ALTER TABLE/i.test(q))).toBe(false);
  });

  it('applies when asked, routing statements through the engine', async () => {
    const { ds, queries } = stubDs();
    const result = await pushSchema(ds, { apply: true });

    expect(result.applied).toBe(true);
    expect(result.statements.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes('create_hypertable'))).toBe(true);
  });

  it('reports no drift and applies nothing when the database already matches', async () => {
    const { ds, queries } = stubDs(['public.metric']);
    const before = queries.length;
    const result = await pushSchema(ds, { apply: true });
    // introspect still reads, but an empty plan must short-circuit before any write
    expect(result.applied).toBe(false);
    expect(result.statements).toEqual([]);
    expect(queries.slice(before).some((q) => /create_hypertable/i.test(q))).toBe(false);
  });
});

describe('pushSchema — the two safety gates are actually forwarded', () => {
  /**
   * These pin the WIRING, not just the parsing. Before them, deleting `allowDrops` from the
   * diffSchemaState call — or inverting the allowRefused spread — left the whole suite green.
   */
  class Bare {}
  Hypertable({ chunkInterval: '1 day' })(Bare); // declares NO retention
  TimeColumn()(Bare.prototype, 'ts');
  HypertablePrimaryKey()(Bare.prototype, 'ts');

  /** A DataSource whose live schema has a hypertable WITH a retention policy. */
  function dsWithRetention(): { ds: DataSource; queries: string[] } {
    const queries: string[] = [];
    const runner = {
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
      get isTransactionActive() {
        return false;
      },
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_extension')) return [{ extversion: '2.18.0' }];
        if (sql.includes('timescaledb_information.hypertables'))
          return [{ hypertable_schema: 'public', hypertable_name: 'bare' }];
        if (sql.includes('timescaledb_information.dimensions'))
          return [
            {
              hypertable_schema: 'public',
              hypertable_name: 'bare',
              dimension_number: 1,
              column_name: 'ts',
              dimension_type: 'Time',
              time_interval: '1 day',
              integer_interval: null,
              num_partitions: null,
            },
          ];
        if (sql.includes('timescaledb_information.jobs'))
          return [
            {
              proc_name: 'policy_retention',
              schedule_interval: '1 day',
              hypertable_schema: 'public',
              hypertable_name: 'bare',
              mat_hypertable_id: null,
              config: { drop_after: '30 days' },
            },
          ];
        return [];
      },
    };
    const ds = {
      isInitialized: true,
      options: {},
      entityMetadatas: [{ target: Bare, tableName: 'bare', columns: [] }],
      createQueryRunner: () => runner,
    } as unknown as DataSource;
    return { ds, queries };
  }

  it('does NOT emit a policy removal without allowDrops', async () => {
    const { ds } = dsWithRetention();
    const { plan } = await pushSchema(ds);
    expect(plan.steps.some((s) => s.operation.kind === 'removeRetentionPolicy')).toBe(false);
  });

  it('DOES emit the removal when allowDrops is forwarded', async () => {
    // Fails if `allowDrops` stops reaching diffSchemaState.
    const { ds } = dsWithRetention();
    const { plan } = await pushSchema(ds, { allowDrops: true });
    expect(plan.steps.some((s) => s.operation.kind === 'removeRetentionPolicy')).toBe(true);
  });

  /** Live DB retains 365 days; the entity declares 30 — a SHORTENING alter, refuse-by-default. */
  class Shrinking {}
  Hypertable({ chunkInterval: '1 day', retention: { dropAfter: '30 days' } })(Shrinking);
  TimeColumn()(Shrinking.prototype, 'ts');
  HypertablePrimaryKey()(Shrinking.prototype, 'ts');

  function dsShrinking(): { ds: DataSource; queries: string[] } {
    const queries: string[] = [];
    const runner = {
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
      get isTransactionActive() {
        return false;
      },
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_extension')) return [{ extversion: '2.18.0' }];
        if (sql.includes('timescaledb_information.hypertables'))
          return [{ hypertable_schema: 'public', hypertable_name: 'shrinking' }];
        if (sql.includes('timescaledb_information.dimensions'))
          return [
            {
              hypertable_schema: 'public',
              hypertable_name: 'shrinking',
              dimension_number: 1,
              column_name: 'ts',
              dimension_type: 'Time',
              time_interval: '1 day',
              integer_interval: null,
              num_partitions: null,
            },
          ];
        if (sql.includes('timescaledb_information.jobs'))
          return [
            {
              proc_name: 'policy_retention',
              schedule_interval: '1 day',
              hypertable_schema: 'public',
              hypertable_name: 'shrinking',
              mat_hypertable_id: null,
              config: { drop_after: '365 days' },
            },
          ];
        return [];
      },
    };
    const ds = {
      isInitialized: true,
      options: {},
      entityMetadatas: [{ target: Shrinking, tableName: 'shrinking', columns: [] }],
      createQueryRunner: () => runner,
    } as unknown as DataSource;
    return { ds, queries };
  }

  it('pushSchema WITHHOLDS the refuse-by-default permission unless allowRefused is passed', async () => {
    // Goes through pushSchema (not applyDirect directly), so inverting the conditional spread in
    // push.ts is caught. Mutation-verified: hardcoding allowRefuseByDefault:true fails this test.
    const { ds, queries } = dsShrinking();
    const preview = await pushSchema(ds);
    expect(preview.plan.steps.map((s) => s.safety)).toContain('refuse-by-default');

    await expect(pushSchema(ds, { apply: true })).rejects.toThrow(/refuse-by-default/);
    expect(queries.some((q) => /add_retention_policy/i.test(q))).toBe(false); // nothing ran
  });

  it('pushSchema GRANTS it when allowRefused is passed', async () => {
    const { ds, queries } = dsShrinking();
    const result = await pushSchema(ds, { apply: true, allowRefused: true });
    expect(result.applied).toBe(true);
    expect(queries.some((q) => /add_retention_policy/i.test(q))).toBe(true);
  });

  it('refuses a refuse-by-default step unless allowRefused is forwarded', async () => {
    // A SHORTENING retention alter classifies refuse-by-default (the next run drops retained
    // chunks). applyDirect must reject it — proving `allowRefused` reaches it, and that omitting
    // the flag genuinely withholds the permission.
    const plan = {
      steps: [
        {
          operation: {
            kind: 'alterRetentionPolicy' as const,
            table: 'public.bare',
            from: '365 days',
            to: '30 days',
          },
          ...classifyOperation({
            kind: 'alterRetentionPolicy',
            table: 'public.bare',
            from: '365 days',
            to: '30 days',
          }),
        },
      ],
    };
    expect(plan.steps[0]!.safety).toBe('refuse-by-default'); // premise holds

    const { ds, queries } = dsWithRetention();
    await expect(applyDirect(ds, plan)).rejects.toThrow(/refuse-by-default/);
    expect(queries.some((q) => /add_retention_policy/i.test(q))).toBe(false); // nothing ran

    await expect(applyDirect(ds, plan, { allowRefuseByDefault: true })).resolves.toBeDefined();
  });
});

describe('pushCommand — the exit-code contract', () => {
  const fakeLogger = (): { logger: Logger; lines: string[] } => {
    const lines: string[] = [];
    return { logger: { log: (m) => lines.push(m), error: (m) => lines.push(m) }, lines };
  };

  class Conv {}
  Hypertable({ chunkInterval: '1 day' })(Conv);
  TimeColumn()(Conv.prototype, 'ts');
  HypertablePrimaryKey()(Conv.prototype, 'ts');

  /** `hypertables` non-empty ⇒ the DB already matches the entity ⇒ no drift. */
  function ds(converged: boolean): DataSource {
    const runner = {
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
      get isTransactionActive() {
        return false;
      },
      query: async (sql: string) => {
        if (sql.includes('pg_extension')) return [{ extversion: '2.18.0' }];
        if (sql.includes('timescaledb_information.hypertables'))
          return converged ? [{ hypertable_schema: 'public', hypertable_name: 'conv' }] : [];
        if (converged && sql.includes('timescaledb_information.dimensions'))
          return [
            {
              hypertable_schema: 'public',
              hypertable_name: 'conv',
              dimension_number: 1,
              column_name: 'ts',
              dimension_type: 'Time',
              time_interval: '1 day',
              integer_interval: null,
              num_partitions: null,
            },
          ];
        return [];
      },
    };
    return {
      isInitialized: true,
      options: {},
      entityMetadatas: [{ target: Conv, tableName: 'conv', columns: [] }],
      createQueryRunner: () => runner,
    } as unknown as DataSource;
  }

  it("returns 'no-drift' (exit 0) when the database already matches", async () => {
    const { logger, lines } = fakeLogger();
    expect(await pushCommand(ds(true), logger)).toBe('no-drift');
    expect(lines.join('\n')).toMatch(/No drift detected/);
  });

  it("returns 'previewed' (exit 2) when there is drift and nothing was applied", async () => {
    // Exit 2 is a public, script-facing contract: "there is drift and I did not touch it".
    const { logger, lines } = fakeLogger();
    expect(await pushCommand(ds(false), logger)).toBe('previewed');
    expect(lines.join('\n')).toMatch(/Preview only — nothing was applied/);
    expect(lines.join('\n')).toMatch(/--apply/);
  });

  it("returns 'applied' (exit 0) after converging", async () => {
    const { logger, lines } = fakeLogger();
    expect(await pushCommand(ds(false), logger, { apply: true })).toBe('applied');
    expect(lines.join('\n')).toMatch(/Applied \d+ statement/);
  });

  it("never reports 'applied' for a preview", async () => {
    const { logger } = fakeLogger();
    expect(await pushCommand(ds(false), logger)).not.toBe('applied');
  });
});
