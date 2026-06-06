import { describe, expect, it } from 'vitest';
import {
  assertSafeIdentifier,
  quoteIdent,
  quoteQualified,
  TimescaleError,
  TimescaleErrorCode,
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

  it('does not let a malicious part smuggle qualification', () => {
    // The dot splits parts; an injected dot just yields more quoted parts, never raw SQL.
    expect(quoteQualified('a.b.c')).toBe('"a"."b"."c"');
  });
});
