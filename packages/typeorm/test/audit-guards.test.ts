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

// A raw U+0000 byte in a source file makes git classify that file as BINARY, and a binary file gets
// no diff — which is how three of them sat in `runtime/introspect.ts` across every review this
// package has had. The file is a `\0`-separated composite Map key, written as literal bytes rather
// than the `\0` escape; the escape produces the identical string, so nothing about the behaviour
// depended on the literal form, only the reviewability did. It also contradicted the repo's own
// `*.ts text` .gitattributes entry.
describe('sources contain no raw control bytes that would make git treat them as binary', () => {
  it('no tracked TypeScript source contains a literal NUL', async () => {
    const { readFileSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { join } = await import('node:path');

    const repoRoot = join(import.meta.dirname, '../../..');
    const tracked = execFileSync('git', ['ls-files', '*.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.length > 0);

    // A file list that came back empty would make this pass without checking anything.
    expect(tracked.length).toBeGreaterThan(50);

    const offenders = tracked.filter((relative) =>
      readFileSync(join(repoRoot, relative)).includes(0),
    );
    expect(
      offenders,
      `these sources hold a raw NUL byte, so git treats them as binary and shows no diff for them: ` +
        `${offenders.join(', ')}. Write the escape (\\0) instead — it is the same string value.`,
    ).toEqual([]);
  });
});
