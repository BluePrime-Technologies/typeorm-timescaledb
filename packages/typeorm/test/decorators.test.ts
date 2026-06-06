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
    columnstore: {
      segmentBy: ['symbol'],
      orderBy: [{ column: 'ts', direction: 'DESC' }],
      compressAfter: '7 days',
    },
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
    expect(meta.options.columnstore?.compressAfter).toBe('7 days');
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

  it('rejects unsafe identifiers in EVERY identifier-bearing field', () => {
    const payload = 'a"; DROP TABLE x';
    const attacks: Array<() => void> = [
      () => {
        class C {}
        Hypertable({ timeColumn: payload })(C);
        validateHypertableMetadata(getTimescaleMetadata(C)!, 'C');
      },
      () => {
        class C {}
        Hypertable({ timeColumn: 'ts', columnstore: { segmentBy: [payload] } })(C);
        validateHypertableMetadata(getTimescaleMetadata(C)!, 'C');
      },
      () => {
        class C {}
        Hypertable({ timeColumn: 'ts', columnstore: { orderBy: [{ column: payload }] } })(C);
        validateHypertableMetadata(getTimescaleMetadata(C)!, 'C');
      },
      () => {
        class C {}
        Hypertable({ timeColumn: 'ts', spacePartition: { column: payload, partitions: 4 } })(C);
        validateHypertableMetadata(getTimescaleMetadata(C)!, 'C');
      },
      () => {
        class C {}
        Hypertable({ timeColumn: 'ts' })(C);
        HypertablePrimaryKey()(C.prototype, payload);
        validateHypertableMetadata(getTimescaleMetadata(C)!, 'C');
      },
    ];
    for (const attack of attacks) {
      expect(codeOf(attack)).toBe(TimescaleErrorCode.UNSAFE_IDENTIFIER);
    }
  });

  it('rejects invalid options at decoration time (Zod)', () => {
    expect(codeOf(() => Hypertable({ spacePartition: { column: 'x', partitions: 0 } }))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
    );
    // unknown key (strict schema)
    expect(codeOf(() => Hypertable({ bogus: true } as unknown as Record<string, never>))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
    );
    // malformed interval (validated as an interval, not just a string)
    expect(codeOf(() => Hypertable({ chunkInterval: 'soon' }))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
    );
  });

  it('does NOT treat a class as a hypertable from @TimeColumn alone (needs @Hypertable)', () => {
    class Orphan {}
    TimeColumn()(Orphan.prototype, 'ts');
    HypertablePrimaryKey()(Orphan.prototype, 'ts');
    expect(hasTimescaleMetadata(Orphan)).toBe(false);
    expect(getTimescaleMetadata(Orphan)).toBeUndefined();
  });

  it('requires every partitioning column (incl. space partition) in the primary key', () => {
    class SP {}
    Hypertable({ timeColumn: 'ts', spacePartition: { column: 'tenant', partitions: 4 } })(SP);
    HypertablePrimaryKey()(SP.prototype, 'ts'); // PK omits the space column "tenant"
    expect(codeOf(() => validateHypertableMetadata(getTimescaleMetadata(SP)!, 'SP'))).toBe(
      TimescaleErrorCode.INVALID_HYPERTABLE_PK,
    );
  });

  it('merges @TimeColumn/@HypertablePrimaryKey inherited from a base class', () => {
    class Base {}
    TimeColumn()(Base.prototype, 'ts');
    HypertablePrimaryKey()(Base.prototype, 'ts');
    class Sub extends Base {}
    Hypertable({ chunkInterval: '1 day' })(Sub);
    HypertablePrimaryKey()(Sub.prototype, 'id');

    const meta = getTimescaleMetadata(Sub)!;
    expect(meta.timeColumn).toBe('ts'); // inherited from Base
    expect(meta.primaryKeyColumns).toEqual(['ts', 'id']); // base-first + derived
    expect(() => validateHypertableMetadata(meta, 'Sub')).not.toThrow();
    expect(hasTimescaleMetadata(Base)).toBe(false); // base alone is not a hypertable
  });
});
