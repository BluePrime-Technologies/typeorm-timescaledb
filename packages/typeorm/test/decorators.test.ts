import { describe, expect, it } from 'vitest';
import {
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  getTimescaleMetadata,
  hasTimescaleMetadata,
  validateHypertableMetadata,
  TimescaleError,
  TimescaleErrorCode,
} from '../src/index.js';
import type { TimescaleEntityMetadata } from '../src/index.js';

// Decorators are applied by direct invocation (no decorator *syntax*) so the test
// is independent of the runner's experimentalDecorators handling.
function makeTrade(): new () => unknown {
  class Trade {
    id!: string;
    ts!: Date;
    price!: number;
  }
  Hypertable({
    chunkInterval: '7 days',
    columnstore: { segmentBy: ['symbol'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
    retention: { dropAfter: '90 days' },
  })(Trade);
  TimeColumn()(Trade.prototype, 'ts');
  HypertablePrimaryKey()(Trade.prototype, 'id');
  HypertablePrimaryKey()(Trade.prototype, 'ts');
  return Trade;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof TimescaleError ? e.code : `non-timescale:${String(e)}`;
  }
  return undefined;
}

describe('hypertable decorators', () => {
  it('captures metadata on the entity constructor', () => {
    const Trade = makeTrade();
    const meta = getTimescaleMetadata(Trade) as TimescaleEntityMetadata;
    expect(meta).toBeDefined();
    expect(meta.timeColumn).toBe('ts');
    expect(meta.primaryKeyColumns).toEqual(['id', 'ts']);
    expect(meta.options.chunkInterval).toBe('7 days');
    expect(meta.options.columnstore?.segmentBy).toEqual(['symbol']);
    expect(meta.options.columnstore?.orderBy).toEqual([{ column: 'ts', direction: 'DESC' }]);
    expect(meta.options.retention?.dropAfter).toBe('90 days');
  });

  it('reports no metadata for a plain class (WeakMap isolation)', () => {
    class Plain {}
    expect(hasTimescaleMetadata(Plain)).toBe(false);
    expect(getTimescaleMetadata(Plain)).toBeUndefined();
  });

  it('keeps metadata per-constructor isolated', () => {
    const A = makeTrade();
    const B = makeTrade();
    expect(getTimescaleMetadata(A)).not.toBe(getTimescaleMetadata(B));
    expect(getTimescaleMetadata(A)?.primaryKeyColumns).toEqual(['id', 'ts']);
  });

  it('does not replace or mutate the decorated class', () => {
    class C {}
    const ret = (Hypertable({ timeColumn: 'ts' }) as (t: object) => unknown)(C);
    expect(ret).toBeUndefined(); // decorator returns void; class identity unchanged
    expect(Object.getOwnPropertyNames(C.prototype)).toEqual(['constructor']);
  });

  it('validates a well-formed hypertable', () => {
    const Trade = makeTrade();
    expect(() => validateHypertableMetadata(getTimescaleMetadata(Trade)!, 'Trade')).not.toThrow();
  });

  it('rejects a hypertable with no time column', () => {
    class NoTime {}
    Hypertable({ chunkInterval: '1 day' })(NoTime);
    expect(codeOf(() => validateHypertableMetadata(getTimescaleMetadata(NoTime)!, 'NoTime'))).toBe(
      TimescaleErrorCode.NO_TIME_COLUMN,
    );
  });

  it('rejects a primary key that omits the time column', () => {
    class Bad {}
    Hypertable({ timeColumn: 'ts' })(Bad);
    HypertablePrimaryKey()(Bad.prototype, 'id'); // PK = [id], time = ts (missing)
    expect(codeOf(() => validateHypertableMetadata(getTimescaleMetadata(Bad)!, 'Bad'))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_PK,
    );
  });

  it('rejects unsafe identifiers in options', () => {
    class Inj {}
    Hypertable({ timeColumn: 'ts', columnstore: { segmentBy: ['a"; DROP TABLE x'] } })(Inj);
    expect(codeOf(() => validateHypertableMetadata(getTimescaleMetadata(Inj)!, 'Inj'))).toBe(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
    );
  });

  it('rejects invalid options at decoration time (Zod)', () => {
    expect(codeOf(() => Hypertable({ spacePartition: { column: 'x', partitions: 0 } }))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
    );
    // unknown key (strict schema)
    expect(codeOf(() => Hypertable({ bogus: true } as unknown as Record<string, never>))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
    );
  });
});
