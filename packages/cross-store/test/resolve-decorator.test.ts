import { describe, expect, it } from 'vitest';
import { Resolve, getResolveMetadata, CrossStoreError, CrossStoreErrorCode } from '../src/index.js';

// Decorators are applied functionally (no experimentalDecorators needed in this package's config).
class LedgerEntry {
  accountId!: string;
  workspaceId!: string;
}
Resolve('canonical.accounts.id', {
  scope: { workspace_id: 'workspaceId' },
  validators: ['isOpen'],
})(LedgerEntry.prototype, 'accountId');

class Invoice {
  ref!: string;
}
Resolve('canonical.billing.invoices.id')(Invoice.prototype, 'ref'); // schema-qualified table

describe('@Resolve / getResolveMetadata', () => {
  it('records the ref, scope map, and validators for a decorated field', () => {
    const [meta] = getResolveMetadata(LedgerEntry);
    expect(meta).toMatchObject({
      property: 'accountId',
      ref: { store: 'canonical', table: 'accounts', column: 'id' },
      scope: { workspace_id: 'workspaceId' },
      validators: ['isOpen'],
    });
  });

  it('parses a schema-qualified table (store.schema.table.column)', () => {
    const [meta] = getResolveMetadata(Invoice);
    expect(meta.ref).toEqual({ store: 'canonical', table: 'billing.invoices', column: 'id' });
  });

  it('returns [] for a class with no @Resolve fields', () => {
    class Plain {}
    expect(getResolveMetadata(Plain)).toEqual([]);
  });

  it('deep-freezes the recorded metadata (cannot widen scope/validators later)', () => {
    const [meta] = getResolveMetadata(LedgerEntry);
    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta.scope)).toBe(true);
    expect(Object.isFrozen(meta.validators)).toBe(true);
    expect(() => (meta.validators as string[]).push('injected')).toThrow();
  });

  it('rejects a malformed spec (fewer than 3 parts, or an empty part)', () => {
    class Bad {}
    for (const spec of ['store.table', 'store.', '.table.col', 'a..b.c']) {
      expect(() => Resolve(spec)(Bad.prototype, 'x'), spec).toThrowError(CrossStoreError);
    }
    try {
      Resolve('store.table')(Bad.prototype, 'x');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
    }
  });

  it('rejects a symbol property', () => {
    class Sym {}
    const key = Symbol('s');
    expect(() => Resolve('a.b.c')(Sym.prototype, key)).toThrowError(CrossStoreError);
  });

  it('rejects a static-member decoration (target is the constructor, not the prototype)', () => {
    class Stat {}
    // a static decoration passes the constructor as target — must be rejected (else fail-open)
    expect(() => Resolve('a.b.c')(Stat as unknown as object, 'x')).toThrowError(CrossStoreError);
  });

  it('lets a subclass inherit base @Resolve fields and override by name', () => {
    class Base {
      a!: string;
      b!: string;
    }
    Resolve('s.t.a')(Base.prototype, 'a');
    Resolve('s.t.b')(Base.prototype, 'b');
    class Sub extends Base {}
    Resolve('s.other.a')(Sub.prototype, 'a'); // override the inherited 'a'

    const meta = getResolveMetadata(Sub);
    const byProp = Object.fromEntries(meta.map((m) => [m.property, m.ref.table]));
    expect(byProp).toEqual({ a: 'other', b: 't' }); // 'a' overridden, 'b' inherited
  });
});
