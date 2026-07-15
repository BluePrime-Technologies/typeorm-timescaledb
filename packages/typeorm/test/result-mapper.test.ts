import { describe, expect, it } from 'vitest';
import { TimescaleError } from '../src/index.js';
import {
  mapRawRows,
  toBigIntString,
  toDate,
  toNumber,
  toNumberArray,
  toNumberOrNull,
} from '../src/index.js';

describe('toNumber', () => {
  it('passes through finite numbers', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(3.14)).toBe(3.14);
  });
  it('parses pg numeric/decimal strings', () => {
    expect(toNumber('45')).toBe(45);
    expect(toNumber('20.5')).toBe(20.5);
  });
  it('coerces bigint', () => {
    expect(toNumber(7n)).toBe(7);
  });
  it('rejects NaN, non-numeric strings, and null', () => {
    expect(() => toNumber(Number.NaN)).toThrowError(TimescaleError);
    expect(() => toNumber('abc')).toThrowError(TimescaleError);
    expect(() => toNumber(null)).toThrowError(TimescaleError);
  });
  it('rejects integer strings beyond safe precision (no silent rounding)', () => {
    expect(() => toNumber('9007199254740993')).toThrowError(TimescaleError);
  });
});

describe('toNumberOrNull', () => {
  it('passes null/undefined through', () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
  });
  it('coerces present values', () => {
    expect(toNumberOrNull('5')).toBe(5);
  });
});

describe('toBigIntString', () => {
  it('keeps integer strings as-is (no precision loss)', () => {
    expect(toBigIntString('9007199254740993')).toBe('9007199254740993');
  });
  it('stringifies bigint and integer numbers', () => {
    expect(toBigIntString(10n)).toBe('10');
    expect(toBigIntString(3)).toBe('3');
  });
  it('rejects non-integers', () => {
    expect(() => toBigIntString('1.5')).toThrowError(TimescaleError);
    expect(() => toBigIntString(2.5)).toThrowError(TimescaleError);
  });
  it('normalizes negative zero', () => {
    expect(toBigIntString('-0')).toBe('0');
  });
});

describe('toDate', () => {
  it('passes Date through and parses ISO strings', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(toDate(d)).toBe(d);
    expect(toDate('2024-01-01T00:00:00Z').getTime()).toBe(d.getTime());
  });
  it('rejects unparseable input', () => {
    expect(() => toDate('not-a-date')).toThrowError(TimescaleError);
  });
});

describe('toNumberArray', () => {
  it('coerces an int[] result', () => {
    expect(toNumberArray([0, '1', 2])).toEqual([0, 1, 2]);
  });
  it('rejects non-arrays', () => {
    expect(() => toNumberArray('x')).toThrowError(TimescaleError);
  });
});

describe('mapRawRows', () => {
  it('maps rows with index', () => {
    expect(mapRawRows([{ v: '1' }, { v: '2' }], (r) => toNumber(r.v))).toEqual([1, 2]);
  });
});
