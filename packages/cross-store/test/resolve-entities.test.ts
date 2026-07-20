import { describe, expect, it } from 'vitest';
import {
  Resolve,
  ReferenceRegistry,
  resolveEntities,
  assertEntitiesResolved,
  assertEntitiesUnchanged,
  assertEntitiesRegistered,
  CrossStoreError,
  CrossStoreErrorCode,
} from '../src/index.js';
import type { EntityFieldVerdict } from '../src/index.js';
import type { CrossStoreAdapter, FindManyInput, SnapshotRow, ValidatorMap } from '../src/index.js';

class InMemoryAdapter implements CrossStoreAdapter {
  readonly calls: FindManyInput[] = [];
  constructor(
    readonly store: string,
    private readonly rows: SnapshotRow[],
  ) {}
  findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    this.calls.push(input);
    const ids = new Set(input.ids.map(String));
    return Promise.resolve(
      this.rows.filter((r) => {
        if (!ids.has(String(r[input.column]))) return false;
        if (input.scope) {
          for (const [c, v] of Object.entries(input.scope))
            if (String(r[c]) !== String(v)) return false;
        }
        return true;
      }),
    );
  }
}

const REF = { store: 'canonical', table: 'accounts', column: 'id' };

// Entity: a ledger entry referencing an account, scoped by workspace, validated for open-ness.
class LedgerEntry {
  accountId: string | null = null;
  workspaceId = 'w1';
  constructor(accountId: string | null, workspaceId = 'w1') {
    this.accountId = accountId;
    this.workspaceId = workspaceId;
  }
}
Resolve('canonical.accounts.id', {
  scope: { workspace_id: 'workspaceId' },
  validators: ['isOpen'],
})(LedgerEntry.prototype, 'accountId');

// A REQUIRED reference (no scope) — a null/undefined value must fail closed, not skip.
class RequiredEntry {
  accountId?: string;
}
Resolve('canonical.accounts.id', { required: true })(RequiredEntry.prototype, 'accountId');

function fixture() {
  const registry = new ReferenceRegistry().register({
    ...REF,
    scopeColumns: ['workspace_id'],
    targetIsAppendOnly: true,
  });
  const adapter = new InMemoryAdapter('canonical', [
    { id: 'a', workspace_id: 'w1', status: 'open' },
    { id: 'b', workspace_id: 'w1', status: 'closed' },
    { id: 'c', workspace_id: 'w2', status: 'open' },
  ]);
  const validators: ValidatorMap = { isOpen: (row) => row.status === 'open' };
  return { registry, adapter, validators };
}

describe('resolveEntities', () => {
  it('resolves a decorated field and tags the verdict with entity + property', async () => {
    const { registry, adapter, validators } = fixture();
    const entity = new LedgerEntry('a');
    const [r] = await resolveEntities([entity], { registry, adapters: [adapter], validators });
    expect(r?.entity).toBe(entity);
    expect(r?.property).toBe('accountId');
    expect(r?.verdict.ok).toBe(true);
  });

  it('skips a null/undefined FK (no reference to check)', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry(null)], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(results).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it('does NOT skip a falsy-but-present FK ("" is a real id, only null/undefined skip)', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry('')], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(results).toHaveLength(1); // NOT skipped
    expect(results[0]?.verdict.status).toBe('not_found'); // no row with id ''
  });

  it('required: an undefined FK fails closed (throws) instead of being silently skipped', async () => {
    const { registry, adapter, validators } = fixture();
    await expect(
      resolveEntities([new RequiredEntry()], { registry, adapters: [adapter], validators }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    expect(adapter.calls).toHaveLength(0);
  });

  it('required: a present FK resolves normally', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new RequiredEntry();
    e.accountId = 'a';
    const [r] = await resolveEntities([e], { registry, adapters: [adapter], validators });
    expect(r?.verdict.ok).toBe(true);
  });

  it('FAILS CLOSED on a spread/plain-object DTO — does NOT silently skip a required ref', async () => {
    const { registry, adapter, validators } = fixture();
    const instance = new RequiredEntry();
    instance.accountId = 'a';
    const pojo = { ...instance }; // detached: constructor is Object → no metadata
    await expect(
      resolveEntities([pojo], { registry, adapters: [adapter], validators }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    expect(adapter.calls).toHaveLength(0);
  });

  it('throws INVALID_ARGUMENT (not a raw TypeError) for a null/non-object entity', async () => {
    const { registry, adapter, validators } = fixture();
    for (const bad of [null, undefined, 42, 'x']) {
      await expect(
        resolveEntities([bad as unknown as object], { registry, adapters: [adapter], validators }),
      ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    }
  });

  it('accepts a class instance with no @Resolve fields (returns [], does not throw)', async () => {
    const { registry, adapter, validators } = fixture();
    class Plain {}
    const results = await resolveEntities([new Plain()], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(results).toEqual([]);
  });

  it('accepts an Object.create(Class.prototype) instance (real prototype → class recovered)', async () => {
    const { registry, adapter, validators } = fixture();
    const e = Object.create(LedgerEntry.prototype) as LedgerEntry;
    e.accountId = 'a';
    e.workspaceId = 'w1';
    const [r] = await resolveEntities([e], { registry, adapters: [adapter], validators });
    expect(r?.verdict.ok).toBe(true);
  });

  it('throws with entity/field context when a scope sibling property is unset', async () => {
    const { registry, adapter, validators } = fixture();
    const entity = new LedgerEntry('a');
    (entity as { workspaceId: unknown }).workspaceId = undefined;
    try {
      await resolveEntities([entity], { registry, adapters: [adapter], validators });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((e as CrossStoreError).message).toContain('LedgerEntry.accountId');
      expect((e as CrossStoreError).context.scopeProperty).toBe('workspaceId');
    }
  });

  it('pulls the scope value from the sibling property (wrong workspace → not_found)', async () => {
    const { registry, adapter, validators } = fixture();
    // account 'c' exists but in workspace w2; the entity is in w1
    const [r] = await resolveEntities([new LedgerEntry('c', 'w1')], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(r?.verdict.status).toBe('not_found');
    expect(adapter.calls[0]?.scope).toEqual({ workspace_id: 'w1' });
  });

  it('runs the named validator against the fetched row (closed account → validator_failed)', async () => {
    const { registry, adapter, validators } = fixture();
    const [r] = await resolveEntities([new LedgerEntry('b')], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(r?.verdict.status).toBe('validator_failed');
  });

  it('batches multiple entities/fields, preserving per-field origin', async () => {
    const { registry, adapter, validators } = fixture();
    const es = [new LedgerEntry('a'), new LedgerEntry('missing'), new LedgerEntry('a')];
    const results = await resolveEntities(es, { registry, adapters: [adapter], validators });
    expect(results.map((r) => r.verdict.status)).toEqual(['resolved', 'not_found', 'resolved']);
    expect(results.map((r) => r.entity)).toEqual(es);
    expect(adapter.calls).toHaveLength(1); // one batched round-trip
  });
});

describe('assertEntitiesResolved', () => {
  it('throws the first failure with ClassName.property context', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry('missing')], {
      registry,
      adapters: [adapter],
      validators,
    });
    try {
      assertEntitiesResolved(results);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).message).toContain('LedgerEntry.accountId');
      expect((e as CrossStoreError).context.property).toBe('accountId');
    }
  });

  it('returns the results unchanged when everything resolved', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry('a')], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(assertEntitiesResolved(results)).toBe(results);
  });

  it('does NOT collapse a malformed unavailable verdict into REFERENCE_NOT_FOUND (fix #5)', () => {
    // a hand-built failed verdict missing its error must surface as INVALID_ARGUMENT, never
    // an invented not_found (mirrors the engine's assertAllResolved hardening)
    const bogus = [
      {
        entity: new LedgerEntry('a'),
        property: 'accountId',
        verdict: { check: { ref: REF, value: 'a' }, ok: false, status: 'unavailable' as const },
      },
    ];
    try {
      assertEntitiesResolved(bogus);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((e as CrossStoreError).code).not.toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
    }
  });
});

describe('assertEntitiesUnchanged (write-path TOCTOU re-check)', () => {
  it('passes when a scoped field is unchanged between validation and save', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry('a')], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(() => assertEntitiesUnchanged(results)).not.toThrow();
  });

  it('throws when the validated value changed under the same instance', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    e.accountId = 'ghost'; // swap in an unvalidated reference after validation
    expect(() => assertEntitiesUnchanged(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('throws when the validated scope drifted under the same instance', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a', 'w1');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    e.workspaceId = 'w2'; // FK unchanged, tenant scope drifted
    expect(() => assertEntitiesUnchanged(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('fails CLOSED when a verdict carries a scope but the class metadata no longer declares one', () => {
    // The o3 MAJOR case: a validated-with-scope verdict re-checked against an entity whose class
    // has NO scope metadata (RequiredEntry) must throw rather than silently skip the scope check.
    const e = new RequiredEntry();
    e.accountId = 'a';
    const results: EntityFieldVerdict[] = [
      {
        entity: e,
        property: 'accountId',
        verdict: {
          check: { ref: REF, value: 'a', scope: { workspace_id: 'w1' } },
          ok: true,
          status: 'found',
        },
      },
    ];
    try {
      assertEntitiesUnchanged(results);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((err as CrossStoreError).message).toContain('cannot re-verify scope');
    }
  });
});

describe('assertEntitiesRegistered (boot-time wiring)', () => {
  it('passes when every @Resolve triple + scope column is registered', () => {
    const { registry } = fixture();
    expect(() => assertEntitiesRegistered([LedgerEntry], registry)).not.toThrow();
  });

  it('throws REFERENCE_NOT_ALLOWED for an unregistered target', () => {
    const empty = new ReferenceRegistry();
    try {
      assertEntitiesRegistered([LedgerEntry], empty);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.REFERENCE_NOT_ALLOWED);
    }
  });

  it('throws SCOPE_VIOLATION when a @Resolve uses a non-allowlisted scope column', () => {
    // register the target WITHOUT the workspace_id scope column
    const registry = new ReferenceRegistry().register(REF);
    try {
      assertEntitiesRegistered([LedgerEntry], registry);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.SCOPE_VIOLATION);
    }
  });
});
