import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { quoteLiteral, TimescaleError, TimescaleErrorCode } from '../src/index.js';

/** Reverse of quoteLiteral for round-trip testing: strip outer quotes, undouble. */
function unquote(q: string): string {
  return q.slice(1, -1).replace(/''/g, "'");
}

/** True if the string contains an ASCII control char (code < 0x20) or DEL (0x7f). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

describe('quoteLiteral', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteLiteral('metrics')).toBe("'metrics'");
  });

  it('doubles embedded single quotes (neutralizes break-out)', () => {
    expect(quoteLiteral("a'b")).toBe("'a''b'");
    expect(quoteLiteral("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'");
  });

  it('rejects control characters and null bytes', () => {
    for (const bad of [
      `a${String.fromCharCode(0)}b`,
      `a${String.fromCharCode(10)}b`,
      `a${String.fromCharCode(127)}`,
    ]) {
      expect(() => quoteLiteral(bad)).toThrow(TimescaleError);
    }
  });

  it('throws INVALID_ARGUMENT on control chars', () => {
    try {
      quoteLiteral(`x${String.fromCharCode(9)}`, 'segmentBy');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
    }
  });

  it('property: round-trips any control-free string and never leaves an unescaped quote', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !hasControl(s)),
        (s) => {
          const q = quoteLiteral(s);
          // structural: starts/ends with a single quote
          expect(q.startsWith("'")).toBe(true);
          expect(q.endsWith("'")).toBe(true);
          // the interior has no lone single quote (every ' is part of a '' pair)
          const interior = q.slice(1, -1);
          expect(interior.replace(/''/g, '')).not.toContain("'");
          // round-trip is lossless
          expect(unquote(q)).toBe(s);
        },
      ),
      { numRuns: 500 },
    );
  });
});
