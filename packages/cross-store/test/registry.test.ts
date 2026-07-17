import { describe, expect, it } from 'vitest';
import { ReferenceRegistry, CrossStoreError, CrossStoreErrorCode } from '../src/index.js';

const CANONICAL = { store: 'canonical', table: 'canonical_records', column: 'id' };

function seeded(): ReferenceRegistry {
  return new ReferenceRegistry().register({
    ...CANONICAL,
    scopeColumns: ['workspace_id'],
    targetIsAppendOnly: true,
  });
}

describe('ReferenceRegistry', () => {
  it('registers and reports an allowed target', () => {
    const reg = seeded();
    expect(reg.isAllowed(CANONICAL)).toBe(true);
    expect(reg.get(CANONICAL)).toMatchObject({ store: 'canonical', column: 'id' });
    // a different column on the same table is a different (unregistered) target
    expect(reg.isAllowed({ ...CANONICAL, column: 'other' })).toBe(false);
  });

  it('assertRegistered throws REFERENCE_NOT_ALLOWED for an unregistered target', () => {
    const reg = seeded();
    expect(reg.assertRegistered(CANONICAL)).toMatchObject({ column: 'id' });
    expect(() => reg.assertRegistered({ ...CANONICAL, table: 'other' })).toThrowError(
      CrossStoreError,
    );
    try {
      reg.assertRegistered({ ...CANONICAL, table: 'other' });
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.REFERENCE_NOT_ALLOWED);
    }
  });

  it('rejects unsafe identifiers at registration (fail fast)', () => {
    const reg = new ReferenceRegistry();
    expect(() => reg.register({ store: 'c', table: 't', column: 'id);--' })).toThrow();
    expect(() => reg.register({ store: 'c', table: 't);--', column: 'id' })).toThrow();
    expect(() => reg.register({ store: 'c);--', table: 't', column: 'id' })).toThrow();
    expect(() =>
      reg.register({ store: 'c', table: 't', column: 'id', scopeColumns: ['ws);--'] }),
    ).toThrow();
  });

  it('rejects a malformed (>2 part / empty) table', () => {
    const reg = new ReferenceRegistry();
    expect(() => reg.register({ store: 'c', table: 'a.b.c', column: 'id' })).toThrowError(
      CrossStoreError,
    );
    expect(() => reg.register({ store: 'c', table: '', column: 'id' })).toThrowError(
      CrossStoreError,
    );
  });

  it('accepts a schema-qualified table', () => {
    const reg = new ReferenceRegistry().register({
      store: 'canonical',
      table: 'billing.invoices',
      column: 'id',
    });
    expect(reg.isAllowed({ store: 'canonical', table: 'billing.invoices', column: 'id' })).toBe(
      true,
    );
  });

  it('assertScopeAllowed permits allowlisted scope columns and rejects others', () => {
    const reg = seeded();
    expect(() => reg.assertScopeAllowed(CANONICAL, ['workspace_id'])).not.toThrow();
    try {
      reg.assertScopeAllowed(CANONICAL, ['tenant_id']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.SCOPE_VIOLATION);
    }
  });

  it('assertScopeAllowed returns the registered entry (engine reuses it, no 2nd lookup)', () => {
    const reg = seeded();
    const entry = reg.assertScopeAllowed(CANONICAL, ['workspace_id']);
    expect(entry).toMatchObject({ store: 'canonical', column: 'id', targetIsAppendOnly: true });
    expect(Object.isFrozen(entry)).toBe(true);
    // an empty scope list is trivially allowed and still yields the entry
    expect(reg.assertScopeAllowed(CANONICAL, [])).toBe(entry);
  });

  it('assertScopeAllowed on an unregistered target throws REFERENCE_NOT_ALLOWED, not SCOPE_VIOLATION', () => {
    const reg = seeded();
    try {
      reg.assertScopeAllowed({ ...CANONICAL, table: 'ghost' }, ['workspace_id']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.REFERENCE_NOT_ALLOWED);
    }
  });

  it('does not collide a dotted store with a dotted (schema-qualified) table', () => {
    // `store:'a.b' table:'x'` and `store:'a' table:'b.x'` must key to DISTINCT targets —
    // a `.`-joined key would have conflated them. Only the registered one is allowed.
    const reg = new ReferenceRegistry().register({ store: 'a', table: 'b.x', column: 'id' });
    expect(reg.isAllowed({ store: 'a', table: 'b.x', column: 'id' })).toBe(true);
    expect(reg.isAllowed({ store: 'a.b', table: 'x', column: 'id' })).toBe(false);
  });

  it('assertAllRegistered validates a batch and throws on the first missing target', () => {
    const reg = seeded();
    expect(() => reg.assertAllRegistered([CANONICAL])).not.toThrow();
    expect(() =>
      reg.assertAllRegistered([CANONICAL, { ...CANONICAL, column: 'missing' }]),
    ).toThrowError(CrossStoreError);
  });

  it('surfaces non-append-only targets for a startup warning', () => {
    // both an omitted flag and an explicit `false` count as non-append-only
    const reg = seeded()
      .register({ store: 'canonical', table: 'sessions', column: 'id' })
      .register({ store: 'canonical', table: 'drafts', column: 'id', targetIsAppendOnly: false });
    const nonAppendOnly = reg.nonAppendOnlyTargets();
    expect(nonAppendOnly.map((e) => e.table).sort()).toEqual(['drafts', 'sessions']);
    // the append-only target is not warned about
    expect(nonAppendOnly.some((e) => e.table === 'canonical_records')).toBe(false);
  });

  it('preserves the targetIsAppendOnly flag and copies scopeColumns defensively', () => {
    const scope = ['workspace_id'];
    const reg = new ReferenceRegistry().register({ ...CANONICAL, scopeColumns: scope });
    scope.push('mutated'); // mutating the caller's array must not affect the registry
    expect(reg.get(CANONICAL)?.scopeColumns).toEqual(['workspace_id']);
  });

  it('deep-freezes stored entries so a returned entry cannot widen the allowlist', () => {
    const reg = seeded();
    const entry = reg.get(CANONICAL)!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.scopeColumns)).toBe(true);
    // mutating a returned entry's scope array must fail (frozen) and never be accepted
    expect(() => (entry.scopeColumns as string[]).push('injected')).toThrow();
    try {
      reg.assertScopeAllowed(CANONICAL, ['injected']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.SCOPE_VIOLATION);
    }
  });

  it('is idempotent on an identical re-registration but rejects a conflicting one', () => {
    const reg = seeded();
    // identical (order-independent) → fine
    expect(() =>
      reg.register({ ...CANONICAL, scopeColumns: ['workspace_id'], targetIsAppendOnly: true }),
    ).not.toThrow();
    // widened scope → conflict
    expect(() =>
      reg.register({
        ...CANONICAL,
        scopeColumns: ['workspace_id', 'tenant_id'],
        targetIsAppendOnly: true,
      }),
    ).toThrowError(CrossStoreError);
    // dropped append-only flag → conflict
    expect(() => reg.register({ ...CANONICAL, scopeColumns: ['workspace_id'] })).toThrowError(
      CrossStoreError,
    );
  });

  it('rejects empty schema/table parts', () => {
    const reg = new ReferenceRegistry();
    for (const bad of ['schema.', '.tbl', 'a..b']) {
      expect(() => reg.register({ store: 'c', table: bad, column: 'id' })).toThrowError(
        CrossStoreError,
      );
    }
  });
});
