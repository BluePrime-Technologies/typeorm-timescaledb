import { describe, expect, it } from 'vitest';
import {
  assertInterval,
  INTERVAL_PATTERN,
  TimescaleError,
  TimescaleErrorCode,
} from '../src/index.js';

describe('assertInterval', () => {
  it('accepts conservative <n> <unit> intervals (singular and plural)', () => {
    for (const v of [
      '7 days',
      '1 day',
      '30 minutes',
      '12 hours',
      '1 week',
      '6 months',
      '1 year',
      '500 milliseconds',
      '100 microseconds',
    ]) {
      expect(assertInterval(v)).toBe(v);
    }
  });

  it('is case-insensitive on the unit', () => {
    expect(assertInterval('7 DAYS')).toBe('7 DAYS');
  });

  it('rejects non-intervals and injection attempts', () => {
    for (const v of [
      '7 days; DROP TABLE x',
      "1 day'",
      'soon',
      '7',
      'days',
      '-1 day',
      '1.5 days',
      '1 fortnight',
      '',
    ]) {
      expect(() => assertInterval(v)).toThrow(TimescaleError);
    }
  });

  it('throws INVALID_ARGUMENT with the role in context', () => {
    try {
      assertInterval('nope', 'chunkInterval');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
      expect((e as InstanceType<typeof TimescaleError>).context.role).toBe('chunkInterval');
    }
  });

  it('exports the shared pattern used by the metadata schema', () => {
    expect(INTERVAL_PATTERN.test('7 days')).toBe(true);
    expect(INTERVAL_PATTERN.test('garbage')).toBe(false);
  });
});
