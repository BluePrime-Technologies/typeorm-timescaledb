import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { TimescaleError } from '@blueprime/timescaledb-core';
import { getTimeBucket } from '../src/query/getTimeBucket.js';
import { listChunks, listJobs } from '../src/runtime/info.js';

/**
 * Regressions for defects found in the pre-release audit. Each test pins a behaviour that was
 * previously wrong in a way no existing test covered.
 */

/** A repository stub that records the SQL/aliases a query would project, without a database. */
function stubRepo(): { repo: Repository<ObjectLiteral>; selects: Array<[string, string]> } {
  const selects: Array<[string, string]> = [];
  const qb = {
    select(expr: string, alias: string) {
      selects.push([expr, alias]);
      return this;
    },
    addSelect(expr: string, alias: string) {
      selects.push([expr, alias]);
      return this;
    },
    groupBy() {
      return this;
    },
    addGroupBy() {
      return this;
    },
    orderBy() {
      return this;
    },
    andWhere() {
      return this;
    },
    setParameters() {
      return this;
    },
    getRawMany: async () => [],
  };
  const repo = {
    metadata: { findColumnWithPropertyName: (p: string) => ({ databaseName: p }) },
    createQueryBuilder: () => qb,
  } as unknown as Repository<ObjectLiteral>;
  return { repo, selects };
}

describe('getTimeBucket — output alias hardening (audit)', () => {
  it('rejects an alias that would break out of TypeORM 0.3.x alias quoting (injection)', () => {
    // TypeORM 0.3.x quotes an alias WITHOUT escaping embedded double quotes, so an unvalidated
    // alias injected arbitrary select-list SQL. Aliases are now allow-listed like every other
    // identifier in this layer.
    const { repo } = stubRepo();
    const payload = `bucket" , (SELECT current_setting('is_superuser')) AS "pwned`;
    expect(() =>
      getTimeBucket(repo, 'ts', {
        interval: '1 hour',
        bucketAlias: payload,
        metrics: [{ alias: 'v', fn: 'avg', column: 'val' }],
      }),
    ).toThrow(TimescaleError);
  });

  it('rejects an injected METRIC alias too', () => {
    const { repo } = stubRepo();
    expect(() =>
      getTimeBucket(repo, 'ts', {
        interval: '1 hour',
        metrics: [{ alias: `x" , version() AS "leak`, fn: 'avg', column: 'val' }],
      }),
    ).toThrow(TimescaleError);
  });

  it('still accepts ordinary aliases', () => {
    const { repo, selects } = stubRepo();
    void getTimeBucket(repo, 'ts', {
      interval: '1 hour',
      bucketAlias: 'bucket',
      metrics: [{ alias: 'avg_value', fn: 'avg', column: 'val' }],
    });
    expect(selects.map(([, a]) => a)).toEqual(['bucket', 'avg_value']);
  });

  it('rejects a metric alias that collides with the bucket alias (silent column loss)', () => {
    // Postgres allows duplicate output names but a row object keeps only the last — the bucket
    // timestamp silently vanished from every row, with no error.
    const { repo } = stubRepo();
    expect(() =>
      getTimeBucket(repo, 'ts', {
        interval: '1 hour',
        bucketAlias: 'v',
        metrics: [{ alias: 'v', fn: 'avg', column: 'val' }],
      }),
    ).toThrow(/duplicate output alias/);
  });

  it('rejects two metrics sharing an alias', () => {
    const { repo } = stubRepo();
    expect(() =>
      getTimeBucket(repo, 'ts', {
        interval: '1 hour',
        metrics: [
          { alias: 'dup', fn: 'avg', column: 'a' },
          { alias: 'dup', fn: 'max', column: 'b' },
        ],
      }),
    ).toThrow(/duplicate output alias/);
  });
});

describe('info filters — schema scoping (audit)', () => {
  /** Capture the SQL + bound params a listing would run. */
  function captureDs(schema?: string): { ds: DataSource; calls: Array<[string, unknown[]]> } {
    const calls: Array<[string, unknown[]]> = [];
    const ds = {
      options: schema === undefined ? {} : { schema },
      query: async (sql: string, params: unknown[] = []) => {
        calls.push([sql, params]);
        return [];
      },
    } as unknown as DataSource;
    return { ds, calls };
  }

  it('scopes an UNQUALIFIED hypertable filter to the default schema, not every schema', async () => {
    // Previously only `hypertable_name = $1` was applied, so in a schema-per-tenant layout
    // listChunks({ hypertable: 'metrics' }) returned another tenant's chunks.
    const { ds, calls } = captureDs();
    await listChunks(ds, { hypertable: 'metrics' });
    const [sql, params] = calls[0]!;
    expect(sql).toContain('hypertable_schema =');
    expect(params).toEqual(['metrics', 'public']);
  });

  it('honours the DataSource schema for an unqualified name', async () => {
    const { ds, calls } = captureDs('tenant_a');
    await listJobs(ds, { hypertable: 'metrics' });
    expect(calls[0]![1]).toEqual(['metrics', 'tenant_a']);
  });

  it('still respects an explicitly qualified name', async () => {
    const { ds, calls } = captureDs('tenant_a');
    await listChunks(ds, { hypertable: 'other.metrics' });
    expect(calls[0]![1]).toEqual(['metrics', 'other']);
  });
});
