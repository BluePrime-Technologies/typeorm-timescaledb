import { describe, expect, it } from 'vitest';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import { assertTypeOrmPrimaryKeyIncludesPartitioning } from '../src/decorators/index.js';
import { getTopN } from '../src/query/toolkit.js';

// B3 — @Hypertable PK must include the partitioning columns even when the key is declared with
// plain TypeORM @PrimaryColumn (not @HypertablePrimaryKey), caught at codegen/boot, not run time.
describe('assertTypeOrmPrimaryKeyIncludesPartitioning', () => {
  const em = (pk: string[]) => ({
    tableName: 'reading',
    primaryColumns: pk.map((propertyName) => ({ propertyName })),
  });

  it('passes when the TypeORM PK includes every partitioning column', () => {
    expect(() =>
      assertTypeOrmPrimaryKeyIncludesPartitioning(em(['ts', 'tenant']), ['ts', 'tenant']),
    ).not.toThrow();
  });

  it('throws when a plain @PrimaryColumn key omits the time column', () => {
    try {
      assertTypeOrmPrimaryKeyIncludesPartitioning(em(['id']), ['ts']);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TimescaleError).code).toBe(TimescaleErrorCode.INVALID_HYPERTABLE_PK);
      expect((e as TimescaleError).context.missing).toEqual(['ts']);
    }
  });

  it('throws when the PK omits the space-partition column', () => {
    expect(() =>
      assertTypeOrmPrimaryKeyIncludesPartitioning(em(['ts']), ['ts', 'tenant']),
    ).toThrowError(/missing: tenant/);
  });

  it('does NOT enforce when the entity has no primary key (hypertable with no unique constraint is legal)', () => {
    expect(() => assertTypeOrmPrimaryKeyIncludesPartitioning(em([]), ['ts'])).not.toThrow();
  });
});

// B4 — getTopN must validate `n` up front; a NaN/float `n` used to bypass the count>=n guard
// (count < NaN === false) and surface a less-clear error deeper in.
describe('getTopN input validation (fail-fast, no DB)', () => {
  // repo is never dereferenced on the validation-throw path.
  const repo = {} as unknown as Parameters<typeof getTopN>[0];

  it('rejects a NaN n before touching the database', async () => {
    await expect(getTopN(repo, 'ts', { n: Number.NaN, valueColumn: 'v' })).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
  });

  it('rejects a non-integer / non-positive n', async () => {
    await expect(getTopN(repo, 'ts', { n: 2.5, valueColumn: 'v' })).rejects.toThrowError(
      TimescaleError,
    );
    await expect(getTopN(repo, 'ts', { n: 0, valueColumn: 'v' })).rejects.toThrowError(
      TimescaleError,
    );
  });
});
