import { describe, expect, it } from 'vitest';
import { CrossStoreError, CrossStoreErrorCode } from '../src/index.js';

describe('CrossStoreError', () => {
  it('carries a stable code and a frozen context, and is an Error', () => {
    const err = new CrossStoreError(CrossStoreErrorCode.REFERENCE_NOT_FOUND, 'missing', {
      ref: 'canonical.records.id',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CrossStoreError');
    expect(err.code).toBe('XS_REFERENCE_NOT_FOUND');
    expect(err.message).toBe('missing');
    expect(err.context).toEqual({ ref: 'canonical.records.id' });
    expect(Object.isFrozen(err.context)).toBe(true);
  });

  it('distinguishes ADAPTER_UNAVAILABLE from REFERENCE_NOT_FOUND (availability != correctness)', () => {
    expect(CrossStoreErrorCode.ADAPTER_UNAVAILABLE).toBe('XS_ADAPTER_UNAVAILABLE');
    expect(CrossStoreErrorCode.REFERENCE_NOT_FOUND).toBe('XS_REFERENCE_NOT_FOUND');
    expect(CrossStoreErrorCode.ADAPTER_UNAVAILABLE).not.toBe(
      CrossStoreErrorCode.REFERENCE_NOT_FOUND,
    );
  });

  it('defaults context to an empty frozen object', () => {
    const err = new CrossStoreError(CrossStoreErrorCode.INVALID_ARGUMENT, 'bad');
    expect(err.context).toEqual({});
    expect(Object.isFrozen(err.context)).toBe(true);
  });
});
