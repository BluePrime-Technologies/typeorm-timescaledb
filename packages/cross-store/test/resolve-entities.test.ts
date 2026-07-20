import { describe, expect, it } from 'vitest';
import {
  Resolve,
  ReferenceRegistry,
  resolveEntities,
  assertEntitiesResolved,
  assertEntitiesUnchanged,
  assertEntitiesRegistered,
  lockValidatedFields,
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

  it('does NOT fetch a null/undefined FK, but records a not_referenced baseline (issue #140 window #1)', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry(null)], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict.ok).toBe(true);
    expect(results[0]?.verdict.status).toBe('not_referenced');
    expect(results[0]?.verdict.check.value).toBe(null);
    expect(adapter.calls).toHaveLength(0); // still no fetch — not a real reference
  });

  it('records a not_referenced baseline for an undefined FK too', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry(undefined as unknown as null)], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.verdict.status).toBe('not_referenced');
    expect(results[0]?.verdict.check.value).toBe(undefined);
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

  it('preserves ORIGINAL input order even when null-baseline fields are interleaved with checked ones', async () => {
    const { registry, adapter, validators } = fixture();
    const es = [new LedgerEntry(null), new LedgerEntry('a'), new LedgerEntry(null)];
    const results = await resolveEntities(es, { registry, adapters: [adapter], validators });
    // a not_referenced verdict is no longer appended after every checked verdict — each result
    // sits at the same position as its entity in the input, not grouped by kind.
    expect(results.map((r) => r.entity)).toEqual(es);
    expect(results.map((r) => r.verdict.status)).toEqual([
      'not_referenced',
      'resolved',
      'not_referenced',
    ]);
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

  it('passes when a nullable field stays null between validation and save', async () => {
    const { registry, adapter, validators } = fixture();
    const results = await resolveEntities([new LedgerEntry(null)], {
      registry,
      adapters: [adapter],
      validators,
    });
    expect(() => assertEntitiesUnchanged(results)).not.toThrow();
  });

  it('rejects a null→value flip on a nullable field (issue #140 window #1)', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry(null);
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    e.accountId = 'a'; // mid-flight: a null FK acquires a value after validation
    expect(() => assertEntitiesUnchanged(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('rejects a null→foreign-tenant-id flip even though no scope was validated for it', async () => {
    const { registry, adapter, validators } = fixture();
    // the mid-flight value is a real account, just in the wrong tenant — the fix rejects ANY
    // null→value flip regardless of what the new value is, per "do not mutate in-flight".
    const e = new LedgerEntry(null, 'w1');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    e.accountId = 'c'; // account 'c' belongs to workspace w2
    expect(() => assertEntitiesUnchanged(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('rejects a null↔undefined flip too — no exceptions to "do not mutate in-flight"', async () => {
    // ORMs can give null and undefined different write semantics (e.g. TypeORM skips `undefined`
    // in a partial update but writes an explicit NULL for `null`), so this re-check does not treat
    // the two as interchangeable even though both mean "no reference" elsewhere in this module.
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry(undefined as unknown as null);
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    e.accountId = null;
    expect(() => assertEntitiesUnchanged(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
  });
});

describe('lockValidatedFields (write-path re-check→save non-atomicity, issue #140 window #2)', () => {
  it('throws on a concurrent value mutation while locked', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    assertEntitiesUnchanged(results);
    const unlock = lockValidatedFields(results);
    try {
      expect(() => {
        e.accountId = 'ghost';
      }).toThrow(TypeError);
      expect(e.accountId).toBe('a'); // the locked value was never overwritten
    } finally {
      unlock();
    }
  });

  it('throws on a concurrent scope-sibling mutation while locked', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a', 'w1');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    assertEntitiesUnchanged(results);
    const unlock = lockValidatedFields(results);
    try {
      expect(() => {
        e.workspaceId = 'w2';
      }).toThrow(TypeError);
      expect(e.workspaceId).toBe('w1');
    } finally {
      unlock();
    }
  });

  it('also locks a not_referenced (null-baseline) field, so window #1 stays closed during save too', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry(null);
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    const unlock = lockValidatedFields(results);
    try {
      expect(() => {
        e.accountId = 'a';
      }).toThrow(TypeError);
    } finally {
      unlock();
    }
  });

  it('restores full mutability after unlock, even for a field that was never mutated', async () => {
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    const unlock = lockValidatedFields(results);
    unlock();
    expect(() => {
      e.accountId = 'z';
    }).not.toThrow();
    expect(e.accountId).toBe('z');
  });

  it('dedupes a scope sibling shared by two validated fields on the same entity (locks/restores once)', async () => {
    class TwoRefEntry {
      accountId = 'a';
      otherId = 'a';
      workspaceId = 'w1';
    }
    Resolve('canonical.accounts.id', { scope: { workspace_id: 'workspaceId' } })(
      TwoRefEntry.prototype,
      'accountId',
    );
    Resolve('canonical.accounts.id', { scope: { workspace_id: 'workspaceId' } })(
      TwoRefEntry.prototype,
      'otherId',
    );
    const { registry, adapter, validators } = fixture();
    const e = new TwoRefEntry();
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    expect(results).toHaveLength(2); // both fields resolved, sharing the workspaceId sibling
    const unlock = lockValidatedFields(results);
    expect(() => {
      e.workspaceId = 'w2';
    }).toThrow(TypeError);
    unlock();
    expect(() => {
      e.workspaceId = 'w3'; // fully restored — not left locked by the duplicate lock
    }).not.toThrow();
    expect(e.workspaceId).toBe('w3');
  });

  it('fails CLOSED (throws INVALID_ARGUMENT) on a @Resolve field backed by an accessor, not a plain data property', async () => {
    // A getter/setter has no own descriptor with `value` to lock — rather than silently skipping
    // protection for it (a false sense of safety), lockValidatedFields must refuse to proceed.
    class AccessorEntry {
      private _accountId = 'a';
      get accountId(): string {
        return this._accountId;
      }
      set accountId(v: string) {
        this._accountId = v;
      }
    }
    Resolve('canonical.accounts.id')(AccessorEntry.prototype, 'accountId');
    const { registry, adapter, validators } = fixture();
    const e = new AccessorEntry();
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    try {
      lockValidatedFields(results);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((err as CrossStoreError).message).toContain('AccessorEntry.accountId');
    }
    // and the accessor is left fully functional — no partial/broken lock state
    e.accountId = 'z';
    expect(e.accountId).toBe('z');
  });

  it('restores fields already locked earlier in the same call before failing on a later unlockable field', async () => {
    class MixedEntry {
      accountId = 'a';
      get otherId(): string {
        return 'a';
      }
      set otherId(_v: string) {
        /* accessor: cannot be locked */
      }
    }
    Resolve('canonical.accounts.id')(MixedEntry.prototype, 'accountId');
    Resolve('canonical.accounts.id')(MixedEntry.prototype, 'otherId');
    const { registry, adapter, validators } = fixture();
    const e = new MixedEntry();
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    expect(results.map((r) => r.property)).toEqual(['accountId', 'otherId']);
    expect(() => lockValidatedFields(results)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.INVALID_ARGUMENT }),
    );
    // accountId was locked first, then the call failed on otherId — it must have been unlocked
    // again rather than left permanently read-only.
    e.accountId = 'z';
    expect(e.accountId).toBe('z');
  });

  it('fails CLOSED (not open) when a verdict carries a scope but the class metadata no longer declares one', () => {
    // Mirrors assertEntitiesUnchanged's identical "cannot re-verify scope" test: locking must not
    // silently lock zero scope siblings for a verdict that was validated WITH a scope — that would
    // contradict this function's own "FAILS CLOSED" guarantee.
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
      lockValidatedFields(results);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((err as CrossStoreError).message).toContain('cannot lock the scope siblings');
    }
    // the accountId lock taken before the scope-metadata check failed must have been undone too
    e.accountId = 'z';
    expect(e.accountId).toBe('z');
  });

  it('rejects a concurrent mutation across a REAL async tick, not just a synchronous same-turn write', async () => {
    // The earlier createManyResolved integration test mutates synchronously inside the fake
    // save(); this proves the lock survives genuine event-loop interleaving (a separate
    // microtask/macrotask actually getting scheduled between validation and the mutation attempt).
    const { registry, adapter, validators } = fixture();
    const e = new LedgerEntry('a');
    const results = await resolveEntities([e], { registry, adapters: [adapter], validators });
    assertEntitiesUnchanged(results);
    const unlock = lockValidatedFields(results);
    try {
      const concurrentWrite = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            e.accountId = 'ghost'; // a genuinely separate task, not the same synchronous turn
            resolve();
          } catch (err) {
            reject(err as Error);
          }
        }, 0);
      });
      await expect(concurrentWrite).rejects.toThrow(TypeError);
      expect(e.accountId).toBe('a');
    } finally {
      unlock();
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
