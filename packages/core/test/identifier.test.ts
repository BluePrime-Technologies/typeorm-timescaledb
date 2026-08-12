import { describe, expect, it } from 'vitest';
import {
  TimescaleError,
  TimescaleErrorCode,
  assertSafeFragment,
  assertSafeIdentifier,
  locfExpr,
  quoteIdent,
  quoteQualified,
} from '../src/index.js';

describe('assertSafeIdentifier', () => {
  it('accepts conservative identifiers', () => {
    for (const id of ['time', 'created_at', '_private', 'col$1', 'CanonicalRecords']) {
      expect(assertSafeIdentifier(id)).toBe(id);
    }
  });

  it('rejects empty input', () => {
    expect(() => assertSafeIdentifier('')).toThrowError(TimescaleError);
  });

  it('rejects identifiers starting with a digit', () => {
    expect(() => assertSafeIdentifier('1col')).toThrowError(/not a safe identifier/);
  });

  it('rejects injection attempts', () => {
    for (const bad of ['a; DROP TABLE x', 'a"b', 'a b', 'a-b', 'a)b']) {
      expect(() => assertSafeIdentifier(bad)).toThrowError(TimescaleError);
    }
  });

  it('rejects control characters (built without embedding raw control chars)', () => {
    const withNul = `a${String.fromCharCode(0)}b`;
    const withNewline = `a${String.fromCharCode(10)}b`;
    expect(() => assertSafeIdentifier(withNul)).toThrowError(/control characters/);
    expect(() => assertSafeIdentifier(withNewline)).toThrowError(/control characters/);
  });

  it('rejects identifiers longer than 63 bytes', () => {
    expect(() => assertSafeIdentifier('a'.repeat(64))).toThrowError(/63-byte/);
  });

  it('tags errors with a stable code', () => {
    try {
      assertSafeIdentifier('bad;name');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimescaleError);
      expect((err as TimescaleError).code).toBe(TimescaleErrorCode.UNSAFE_IDENTIFIER);
    }
  });
});

describe('quoteIdent', () => {
  it('double-quotes and escapes embedded quotes (format %I parity)', () => {
    expect(quoteIdent('time')).toBe('"time"');
    expect(quoteIdent('weird name')).toBe('"weird name"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('rejects control characters', () => {
    expect(() => quoteIdent(`a${String.fromCharCode(0)}`)).toThrowError(/control characters/);
  });
});

describe('quoteQualified', () => {
  it('quotes each part of a qualified name independently', () => {
    expect(quoteQualified('public.canonical_records')).toBe('"public"."canonical_records"');
  });

  it('rejects 3+ parts (no object is more qualified than schema.name)', () => {
    // A dot never smuggles raw SQL (each part is quoted), but 3+ parts is a malformed identifier
    // and is rejected outright — mirroring parseTable's cap.
    expect(() => quoteQualified('a.b.c')).toThrowError(/schema\.name/);
    expect(() => quoteQualified('a.b.c')).toThrowError(TimescaleError);
  });
});

describe('assertSafeFragment — the composed-fragment surface has a runtime floor', () => {
  // ~25 public helpers wrap an already-built SQL fragment verbatim. No internal caller violates the
  // contract, but it is the largest raw-string surface in the library and until now the contract
  // lived only in prose. This is not a SQL parser: it refuses the constructs that let a fragment
  // stop being an expression, and nothing else.
  it.each([';', '--', '/*'])('refuses a fragment containing %s', (bad) => {
    expect(() => assertSafeFragment(`avg("v") ${bad} rest`, 'aggregateExpr')).toThrow(
      TimescaleError,
    );
  });

  it('refuses an empty fragment', () => {
    expect(() => assertSafeFragment('', 'aggregateExpr')).toThrow(TimescaleError);
  });

  it.each([
    'avg("value")',
    'sum("v")::numeric',
    'count(*) + 1',
    'first("v", "ts")',
    'avg("v" * 2.5)',
    'string_agg("v", \', \')',
  ])('accepts the legitimate expression %s', (good) => {
    expect(assertSafeFragment(good, 'aggregateExpr')).toBe(good);
  });

  it('is applied by the accessor helpers, not just available to callers', () => {
    expect(() => locfExpr('x); DROP TABLE t; --')).toThrow(TimescaleError);
    expect(locfExpr('avg("value")')).toBe('locf(avg("value"))');
  });
});
