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
