import { describe, expect, it } from 'vitest';
import { TimescaleError } from '../src/index.js';
import { standardAggregateExpr } from '../src/query/aggregate.js';

describe('standardAggregateExpr', () => {
  it('builds allow-listed aggregates with a quoted column', () => {
    expect(standardAggregateExpr('avg', 'value')).toBe('avg("value")');
    expect(standardAggregateExpr('sum', 'value')).toBe('sum("value")');
  });
  it('count without a column is count(*)', () => {
    expect(standardAggregateExpr('count')).toBe('count(*)');
    expect(standardAggregateExpr('count', '')).toBe('count(*)');
  });
  it('is case-insensitive (SQL function names are)', () => {
    expect(standardAggregateExpr('AVG', 'value')).toBe('avg("value")');
    expect(standardAggregateExpr('Sum', 'value')).toBe('sum("value")');
  });
  it('rejects a non-allow-listed function', () => {
    expect(() => standardAggregateExpr('drop', 'value')).toThrowError(TimescaleError);
    expect(() => standardAggregateExpr('avg; DROP TABLE x', 'value')).toThrowError(TimescaleError);
  });
  it('rejects an unsafe column (injection guard)', () => {
    expect(() => standardAggregateExpr('sum', 'value); DROP TABLE x;--')).toThrowError(
      TimescaleError,
    );
  });
  it('requires a column for non-count aggregates', () => {
    expect(() => standardAggregateExpr('avg')).toThrowError(TimescaleError);
  });
});

describe('TimescaleQueryBuilder gapfill guards (no DB)', () => {
  // Minimal SelectQueryBuilder stub — chainable, records nothing; we only exercise
  // the wrapper's own guard logic, which runs before any SQL is executed.
  function stubQb() {
    const qb: Record<string, unknown> = {};
    for (const m of ['select', 'addSelect', 'addGroupBy', 'addOrderBy']) {
      qb[m] = () => qb;
    }
    return qb;
  }

  it('refuses locf after a DESC gapfill bucket', async () => {
    const { TimescaleQueryBuilder } = await import('../src/index.js');
    const tqb = new TimescaleQueryBuilder(stubQb() as never);
    tqb.timeBucketGapfill({ interval: '1 hour', column: 'ts' }, 'bucket', { order: 'DESC' });
    expect(() => tqb.locf({ fn: 'avg', column: 'v' }, 'm')).toThrowError(TimescaleError);
    expect(() => tqb.interpolate({ fn: 'avg', column: 'v' }, 'm')).toThrowError(TimescaleError);
  });

  it('allows locf after the default (ASC) gapfill bucket', async () => {
    const { TimescaleQueryBuilder } = await import('../src/index.js');
    const tqb = new TimescaleQueryBuilder(stubQb() as never);
    tqb.timeBucketGapfill({ interval: '1 hour', column: 'ts' }, 'bucket');
    expect(() => tqb.locf({ fn: 'avg', column: 'v' }, 'm')).not.toThrow();
  });
});
