import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertSafeIdentifier,
  quoteIdent,
  quoteQualified,
  safeIdent,
  TimescaleError,
} from '../src/index.js';

const SAFE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const byteLen = (s: string): number => new TextEncoder().encode(s).length;

// Curated adversarial corpus. Control chars are built at runtime (never embedded
// as literals) so the source stays plain ASCII.
const MALICIOUS = [
  '"); DROP TABLE x; --',
  'id,(SELECT 1)',
  'a"b',
  'a b',
  'a-b',
  '1col',
  '',
  'a'.repeat(64),
  'naïve',
  `a${String.fromCharCode(0)}b`, // null byte
  `a${String.fromCharCode(10)}b`, // newline
  `a${String.fromCharCode(127)}`, // DEL
  'a.b"; DROP',
];

describe('identifier safety (property/fuzz)', () => {
  it('assertSafeIdentifier returns the exact input or throws; accepted strings ⊆ allow-list', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        let out: string | undefined;
        let threw = false;
        try {
          out = assertSafeIdentifier(s);
        } catch (e) {
          threw = true;
          expect(e).toBeInstanceOf(TimescaleError);
        }
        if (!threw) {
          expect(out).toBe(s); // never mutated
          expect(SAFE.test(s) && byteLen(s) <= 63).toBe(true); // only allow-listed accepted
        }
      }),
      { numRuns: 6000 },
    );
  });

  it('quoteIdent is injection-safe: output is exactly one quoted identifier that round-trips', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        let q: string;
        try {
          q = quoteIdent(s);
        } catch {
          return; // rejected (empty/control/over-length) is acceptable
        }
        expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
        expect(q.slice(1, -1).replace(/""/g, '"')).toBe(s); // un-double → original; no payload escaped
      }),
      { numRuns: 6000 },
    );
  });

  it('documents the gap: quoteIdent accepts identifiers the allow-list rejects (it only quotes)', () => {
    const gap = MALICIOUS.filter((s) => {
      let allowRejected = false;
      let quoteAccepted = false;
      try {
        assertSafeIdentifier(s);
      } catch {
        allowRejected = true;
      }
      try {
        quoteIdent(s);
        quoteAccepted = true;
      } catch {
        quoteAccepted = false;
      }
      return allowRejected && quoteAccepted;
    });
    expect(gap.length).toBeGreaterThan(0); // e.g. '"); DROP TABLE x; --', 'id,(SELECT 1)'
  });

  it('safeIdent enforces the allow-list (rejects every untrusted non-allow-listed identifier)', () => {
    // diverges from assertSafeIdentifier nowhere: throws iff the allow-list would throw
    fc.assert(
      fc.property(fc.string(), (s) => {
        const safeThrew = throws(() => safeIdent(s));
        const validThrew = throws(() => assertSafeIdentifier(s));
        expect(safeThrew).toBe(validThrew);
      }),
      { numRuns: 6000 },
    );
    for (const bad of MALICIOUS.filter((s) => !SAFE.test(s) || byteLen(s) > 63 || s === '')) {
      expect(() => safeIdent(bad)).toThrowError(TimescaleError);
    }
  });

  it('quoteQualified quotes each dotted part independently (no smuggled qualification)', () => {
    expect(quoteQualified('a.b"; DROP')).toBe('"a"."b""; DROP"');
    expect(quoteQualified('public.canonical_records')).toBe('"public"."canonical_records"');
  });
});

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
