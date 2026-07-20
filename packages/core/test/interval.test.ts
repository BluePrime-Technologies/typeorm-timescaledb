import { describe, expect, it } from 'vitest';
import {
  assertInterval,
  assertPositiveInterval,
  INTERVAL_PATTERN,
  parseHypertableOptions,
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

  it('rejects non-ASCII-space separators (tab/newline/NBSP/line-sep) — `\\s` would wrongly accept them', () => {
    for (const v of ['7\tdays', '7\ndays', '7\u00A0days', '7\u2028days', '7\u3000days']) {
      expect(() => assertInterval(v), JSON.stringify(v)).toThrow(TimescaleError);
    }
  });

  it('accepts multiple ASCII spaces between magnitude and unit', () => {
    expect(assertInterval('7  days')).toBe('7  days');
  });
});

describe('assertPositiveInterval', () => {
  it('accepts a positive interval and returns it unchanged', () => {
    expect(assertPositiveInterval('1 day')).toBe('1 day');
    expect(assertPositiveInterval('007 days')).toBe('007 days'); // magnitude read via parseInt → 7
  });

  it('rejects a zero interval', () => {
    expect(() => assertPositiveInterval('0 days')).toThrowError(/greater than zero/);
    expect(() => assertPositiveInterval('0 seconds')).toThrow(TimescaleError);
  });

  it('rejects a malformed interval (delegates shape to assertInterval)', () => {
    expect(() => assertPositiveInterval('soon')).toThrow(TimescaleError);
    expect(() => assertPositiveInterval('7\tdays')).toThrow(TimescaleError);
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

  it('agrees with the Zod metadata schema (single source of truth)', () => {
    // The decorator path (parseHypertableOptions -> Zod) and the builder path
    // (assertInterval) must accept/reject identically — they share INTERVAL_PATTERN.
    for (const v of ['7 days', '1 hour', 'soon', '7', '1.5 days', '1 day; DROP']) {
      const intervalOk = (() => {
        try {
          assertInterval(v);
          return true;
        } catch {
          return false;
        }
      })();
      const zodOk = (() => {
        try {
          parseHypertableOptions({ chunkInterval: v });
          return true;
        } catch {
          return false;
        }
      })();
      expect(zodOk).toBe(intervalOk);
    }
  });
});
