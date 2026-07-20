import { describe, expect, it } from 'vitest';
import {
  validateHypertableMetadata,
  parseHypertableOptions,
  TimescaleError,
  TimescaleErrorCode,
  type TimescaleEntityMetadata,
} from '../src/index.js';

function meta(over: Partial<TimescaleEntityMetadata> = {}): TimescaleEntityMetadata {
  return {
    options: parseHypertableOptions(over.options ?? {}),
    timeColumn: 'ts',
    primaryKeyColumns: [],
    ...over,
  };
}

describe('validateHypertableMetadata', () => {
  it('accepts a minimal valid hypertable (time column, no PK)', () => {
    expect(() => validateHypertableMetadata(meta())).not.toThrow();
  });

  it('resolves the time column from options.timeColumn when no @TimeColumn', () => {
    const m: TimescaleEntityMetadata = {
      options: parseHypertableOptions({ timeColumn: 'created_at' }),
      primaryKeyColumns: [],
    };
    expect(() => validateHypertableMetadata(m)).not.toThrow();
  });

  it('throws NO_TIME_COLUMN when neither @TimeColumn nor options.timeColumn is set', () => {
    const m: TimescaleEntityMetadata = {
      options: parseHypertableOptions({}),
      primaryKeyColumns: [],
    };
    try {
      validateHypertableMetadata(m, 'Reading');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TimescaleError).code).toBe(TimescaleErrorCode.NO_TIME_COLUMN);
      expect((e as TimescaleError).context.entityName).toBe('Reading');
    }
  });

  it('rejects an unsafe identifier in every position it emits to SQL', () => {
    const bad = 'id); DROP TABLE x; --';
    expect(() => validateHypertableMetadata(meta({ timeColumn: bad }))).toThrowError(
      TimescaleError,
    );
    expect(() =>
      validateHypertableMetadata(
        meta({ options: parseHypertableOptions({ columnstore: { segmentBy: [bad] } }) }),
      ),
    ).toThrow(TimescaleError);
    expect(() =>
      validateHypertableMetadata(
        meta({ options: parseHypertableOptions({ columnstore: { orderBy: [{ column: bad }] } }) }),
      ),
    ).toThrow(TimescaleError);
    expect(() =>
      validateHypertableMetadata(
        meta({
          options: parseHypertableOptions({ spacePartition: { column: bad, partitions: 4 } }),
        }),
      ),
    ).toThrow(TimescaleError);
    expect(() => validateHypertableMetadata(meta({ primaryKeyColumns: [bad] }))).toThrow(
      TimescaleError,
    );
  });

  it('throws INVALID_HYPERTABLE_PK when the PK omits the time column', () => {
    try {
      validateHypertableMetadata(meta({ timeColumn: 'ts', primaryKeyColumns: ['id'] }), 'R');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TimescaleError).code).toBe(TimescaleErrorCode.INVALID_HYPERTABLE_PK);
      expect((e as TimescaleError).context.missing).toEqual(['ts']);
    }
  });

  it('requires the PK to include the SPACE-partition column too', () => {
    const m = meta({
      timeColumn: 'ts',
      primaryKeyColumns: ['ts'], // has time, missing tenant
      options: parseHypertableOptions({ spacePartition: { column: 'tenant', partitions: 4 } }),
    });
    try {
      validateHypertableMetadata(m);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TimescaleError).code).toBe(TimescaleErrorCode.INVALID_HYPERTABLE_PK);
      expect((e as TimescaleError).context.missing).toEqual(['tenant']);
    }
  });

  it('accepts a PK that includes both the time and space-partition columns', () => {
    const m = meta({
      timeColumn: 'ts',
      primaryKeyColumns: ['ts', 'tenant'],
      options: parseHypertableOptions({ spacePartition: { column: 'tenant', partitions: 4 } }),
    });
    expect(() => validateHypertableMetadata(m)).not.toThrow();
  });

  it('skips the PK rule entirely when no PK columns are declared', () => {
    const m = meta({
      timeColumn: 'ts',
      primaryKeyColumns: [],
      options: parseHypertableOptions({ spacePartition: { column: 'tenant', partitions: 4 } }),
    });
    expect(() => validateHypertableMetadata(m)).not.toThrow();
  });
});
