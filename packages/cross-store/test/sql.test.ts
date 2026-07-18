import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import { describe, expect, it } from 'vitest';
import { CrossStoreError } from '../src/errors.js';
import { buildFindManySql } from '../src/sql.js';

// Curated adversarial corpus (mirrors packages/core/test/identifier.fuzz.test.ts) — every
// identifier position (table, schema, column, scope column) must reject every entry here.
const MALICIOUS = [
  '"); DROP TABLE x; --',
  'id,(SELECT 1)',
  'a"b',
  'a b',
  'a-b',
  '1col',
  '',
  `a${String.fromCharCode(0)}b`, // null byte
  `a${String.fromCharCode(10)}b`, // newline
];

describe('buildFindManySql', () => {
  it('builds the expected SQL + params for a plain table, no scope', () => {
    const { sql, params } = buildFindManySql({
      table: 'canonical_records',
      column: 'id',
      ids: ['a', 'b'],
    });
    expect(sql).toBe('SELECT * FROM "canonical_records" WHERE "id" = ANY($1)');
    expect(params).toEqual([['a', 'b']]);
  });

  it('builds a well-defined (matches-nothing) query for an empty id batch — the builder itself does not short-circuit', () => {
    // DataSourceAdapter short-circuits an empty batch before ever calling this builder, but a
    // direct caller of buildFindManySql gets no such guard — it must still produce valid,
    // safely-bound SQL (`= ANY($1)` on an empty array is well-defined in Postgres: no rows).
    const { sql, params } = buildFindManySql({ table: 't', column: 'id', ids: [] });
    expect(sql).toBe('SELECT * FROM "t" WHERE "id" = ANY($1)');
    expect(params).toEqual([[]]);
  });

  it('quotes a schema-qualified table part-by-part', () => {
    const { sql } = buildFindManySql({ table: 'public.canonical_records', column: 'id', ids: [1] });
    expect(sql).toBe('SELECT * FROM "public"."canonical_records" WHERE "id" = ANY($1)');
  });

  it('appends one AND clause per scope column with sequential placeholders', () => {
    const { sql, params } = buildFindManySql({
      table: 't',
      column: 'id',
      ids: ['x'],
      scope: { workspace_id: 'w1', kind: 'inflow' },
    });
    expect(sql).toBe(
      'SELECT * FROM "t" WHERE "id" = ANY($1) AND "workspace_id" = $2 AND "kind" = $3',
    );
    expect(params).toEqual([['x'], 'w1', 'inflow']);
  });

  it('treats an absent/empty scope as no extra clause', () => {
    expect(buildFindManySql({ table: 't', column: 'id', ids: ['x'] }).sql).toBe(
      'SELECT * FROM "t" WHERE "id" = ANY($1)',
    );
    expect(buildFindManySql({ table: 't', column: 'id', ids: ['x'], scope: {} }).sql).toBe(
      'SELECT * FROM "t" WHERE "id" = ANY($1)',
    );
  });

  it('binds ids as a single array parameter, never interpolated into the SQL text', () => {
    const hostile = `x'; DROP TABLE canonical_records; --`;
    const { sql, params } = buildFindManySql({ table: 't', column: 'id', ids: [hostile] });
    expect(sql).not.toContain(hostile);
    expect(sql).toBe('SELECT * FROM "t" WHERE "id" = ANY($1)');
    expect(params).toEqual([[hostile]]);
  });

  it('binds a hostile scope value as a parameter, never interpolated into the SQL text', () => {
    const hostile = `'; DROP TABLE canonical_records; --`;
    const { sql, params } = buildFindManySql({
      table: 't',
      column: 'id',
      ids: ['x'],
      scope: { tenant_id: hostile },
    });
    expect(sql).not.toContain(hostile);
    expect(sql).toBe('SELECT * FROM "t" WHERE "id" = ANY($1) AND "tenant_id" = $2');
    expect(params).toEqual([['x'], hostile]);
  });

  it('rejects every malicious identifier as the table', () => {
    for (const bad of MALICIOUS) {
      expect(() => buildFindManySql({ table: bad, column: 'id', ids: ['x'] })).toThrow(
        TimescaleError,
      );
    }
  });

  it('rejects every malicious identifier as a schema-qualified table part', () => {
    for (const bad of MALICIOUS) {
      if (bad === '') continue; // "".split('.') never yields a malicious second part here
      expect(() => buildFindManySql({ table: `${bad}.records`, column: 'id', ids: ['x'] })).toThrow(
        TimescaleError,
      );
      expect(() => buildFindManySql({ table: `public.${bad}`, column: 'id', ids: ['x'] })).toThrow(
        TimescaleError,
      );
    }
  });

  it('rejects every malicious identifier as the reference column', () => {
    for (const bad of MALICIOUS) {
      expect(() => buildFindManySql({ table: 't', column: bad, ids: ['x'] })).toThrow(
        TimescaleError,
      );
    }
  });

  it('rejects every malicious identifier as a scope column name', () => {
    for (const bad of MALICIOUS) {
      expect(() =>
        buildFindManySql({ table: 't', column: 'id', ids: ['x'], scope: { [bad]: 'v' } }),
      ).toThrow(TimescaleError);
    }
  });

  it('throws TSDB_UNSAFE_IDENTIFIER (not a generic error) so callers can distinguish the failure', () => {
    try {
      buildFindManySql({ table: 'x); --', column: 'id', ids: ['x'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as TimescaleError).code).toBe(TimescaleErrorCode.UNSAFE_IDENTIFIER);
    }
  });

  it('rejects a table qualified with more than schema.table (mirrors the registry shape check)', () => {
    expect(() => buildFindManySql({ table: 'a.b.c', column: 'id', ids: ['x'] })).toThrow(
      CrossStoreError,
    );
  });
});
