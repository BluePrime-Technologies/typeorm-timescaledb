import { describe, expect, it } from 'vitest';
import { Resolve, ReferenceRegistry, CrossStoreError, CrossStoreErrorCode } from '../src/index.js';
import type { CrossStoreAdapter, FindManyInput, SnapshotRow, ValidatorMap } from '../src/index.js';
import {
  createManyResolved,
  createResolved,
  verifyReferences,
  warnNonAppendOnlyTargets,
  type EntityWriter,
} from '../src/typeorm.js';

class InMemoryAdapter implements CrossStoreAdapter {
  constructor(
    readonly store: string,
    private readonly rows: SnapshotRow[],
  ) {}
  findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    const ids = new Set(input.ids.map(String));
    return Promise.resolve(this.rows.filter((r) => ids.has(String(r[input.column]))));
  }
}

/** Records what was saved so we can assert write-after-validate ordering. */
class FakeWriter implements EntityWriter {
  saved: object[] = [];
  save<T extends object>(entities: T[]): Promise<T[]> {
    this.saved.push(...entities);
    return Promise.resolve(entities);
  }
}

const REF = { store: 'canonical', table: 'accounts', column: 'id' };

class LedgerEntry {
  constructor(public accountId: string | null) {}
}
Resolve('canonical.accounts.id')(LedgerEntry.prototype, 'accountId');

class RequiredLedgerEntry {
  accountId: string | null = null;
}
Resolve('canonical.accounts.id', { required: true })(RequiredLedgerEntry.prototype, 'accountId');

class ScopedEntry {
  accountId = 'a';
  workspaceId = 'w1';
}
Resolve('canonical.accounts.id', { scope: { workspace_id: 'workspaceId' } })(
  ScopedEntry.prototype,
  'accountId',
);

function fixture() {
  const registry = new ReferenceRegistry().register({ ...REF, targetIsAppendOnly: true });
  const adapter = new InMemoryAdapter('canonical', [{ id: 'a' }, { id: 'b' }]);
  const validators: ValidatorMap = {};
  return { registry, adapter, validators };
}

describe('createManyResolved', () => {
  it('validates all references, then saves (returns the saved entities)', async () => {
    const { registry, adapter } = fixture();
    const writer = new FakeWriter();
    const entities = [new LedgerEntry('a'), new LedgerEntry('b')];
    const saved = await createManyResolved(writer, entities, { registry, adapters: [adapter] });
    expect(saved).toBe(entities);
    expect(writer.saved).toEqual(entities);
  });

  it('does NOT save when any reference is unresolved (fail-closed, no partial write)', async () => {
    const { registry, adapter } = fixture();
    const writer = new FakeWriter();
    const entities = [new LedgerEntry('a'), new LedgerEntry('missing')];
    await expect(
      createManyResolved(writer, entities, { registry, adapters: [adapter] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.REFERENCE_NOT_FOUND });
    expect(writer.saved).toHaveLength(0); // nothing written
  });

  it('skips a nullable FK but still saves the row', async () => {
    const { registry, adapter } = fixture();
    const writer = new FakeWriter();
    const e = new LedgerEntry(null);
    await createManyResolved(writer, [e], { registry, adapters: [adapter] });
    expect(writer.saved).toEqual([e]);
  });

  it('refuses to save a reference mutated between validation and save (fail-closed, no write)', async () => {
    const { registry } = fixture();
    const writer = new FakeWriter();
    const e = new LedgerEntry('a');
    // an adapter that mutates the entity mid-fetch, simulating a concurrent tick during the await
    const mutating: CrossStoreAdapter = {
      store: 'canonical',
      findMany: (input) => {
        e.accountId = 'ghost'; // swap in an unvalidated value after the check captured 'a'
        return Promise.resolve(input.ids.map((id) => ({ id })));
      },
    };
    await expect(
      createManyResolved(writer, [e], { registry, adapters: [mutating] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    expect(writer.saved).toHaveLength(0); // never written
  });

  it('refuses to save when a SCOPE sibling is mutated between validation and save (tenant isolation)', async () => {
    const registry = new ReferenceRegistry().register({ ...REF, scopeColumns: ['workspace_id'] });
    const writer = new FakeWriter();
    const e = new ScopedEntry(); // accountId 'a', workspaceId 'w1'
    // validated under w1; a concurrent tick flips the tenant to w2 while the fetch awaits
    const mutating: CrossStoreAdapter = {
      store: 'canonical',
      findMany: (input) => {
        const row = {
          id: 'a',
          workspace_id: (input.scope as { workspace_id: string }).workspace_id,
        };
        e.workspaceId = 'w2'; // FK value unchanged, but the scope drifts to another tenant
        return Promise.resolve([row]);
      },
    };
    await expect(
      createManyResolved(writer, [e], { registry, adapters: [mutating] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    expect(writer.saved).toHaveLength(0);
  });

  it('saves a scoped entity whose scope is UNCHANGED (no false positive on the scope re-check)', async () => {
    const registry = new ReferenceRegistry().register({ ...REF, scopeColumns: ['workspace_id'] });
    const writer = new FakeWriter();
    const e = new ScopedEntry(); // accountId 'a', workspaceId 'w1' — never mutated
    // an adapter that returns a matching, correctly-scoped row and leaves the entity untouched
    const scoped: CrossStoreAdapter = {
      store: 'canonical',
      findMany: (input) =>
        Promise.resolve([
          { id: 'a', workspace_id: (input.scope as { workspace_id: string }).workspace_id },
        ]),
    };
    const saved = await createManyResolved(writer, [e], { registry, adapters: [scoped] });
    expect(saved).toEqual([e]); // the re-check passes; the write happens
    expect(writer.saved).toEqual([e]);
  });

  it('throws if the writer returns a different number of entities than given', async () => {
    const { registry, adapter } = fixture();
    const shortWriter: EntityWriter = { save: () => Promise.resolve([]) };
    await expect(
      createManyResolved(shortWriter, [new LedgerEntry('a')], { registry, adapters: [adapter] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
  });

  it('refuses a concurrent mutation during writer.save itself (issue #140 window #2 — re-check→save non-atomicity)', async () => {
    const { registry, adapter } = fixture();
    const e = new LedgerEntry('a');
    // simulates a concurrent holder of the same instance mutating it during save's own await —
    // the exact gap `assertEntitiesUnchanged` (which already ran) cannot see.
    const mutatingWriter: EntityWriter = {
      save: async (entities) => {
        (entities[0] as LedgerEntry).accountId = 'ghost';
        return entities;
      },
    };
    await expect(
      createManyResolved(mutatingWriter, [e], { registry, adapters: [adapter] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT }); // wrapped, not a bare TypeError
    expect(e.accountId).toBe('a'); // the locked property could not actually be overwritten
    // the field is unlocked again afterward (the `finally` ran despite the throw)
    e.accountId = 'z';
    expect(e.accountId).toBe('z');
  });

  it('still saves normally when nothing mutates during the (now-locked) save call', async () => {
    const { registry, adapter } = fixture();
    const writer = new FakeWriter();
    const e = new LedgerEntry('a');
    const saved = await createManyResolved(writer, [e], { registry, adapters: [adapter] });
    expect(saved).toEqual([e]);
    // fields are fully mutable again once the call returns
    e.accountId = 'z';
    expect(e.accountId).toBe('z');
  });

  it('does NOT misattribute an UNRELATED TypeError from writer.save to the lock', async () => {
    // a bug in the writer itself (nothing to do with a locked field) must propagate as-is, not
    // get relabeled as a TOCTOU mutation.
    const { registry, adapter } = fixture();
    const e = new LedgerEntry('a');
    const buggyWriter: EntityWriter = {
      save: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'foo')");
      },
    };
    let caught: unknown;
    try {
      await createManyResolved(buggyWriter, [e], { registry, adapters: [adapter] });
      throw new Error('should have thrown');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(CrossStoreError);
  });
});

describe('createResolved', () => {
  it('is single-entity sugar', async () => {
    const { registry, adapter } = fixture();
    const writer = new FakeWriter();
    const e = new LedgerEntry('a');
    expect(await createResolved(writer, e, { registry, adapters: [adapter] })).toBe(e);
    expect(writer.saved).toEqual([e]);
  });
});

describe('verifyReferences (reconciliation sweep)', () => {
  it('reports a genuinely-gone reference as dangling (no write)', async () => {
    const { registry, adapter } = fixture();
    const { dangling, unavailable } = await verifyReferences(
      [new LedgerEntry('a'), new LedgerEntry('missing'), new LedgerEntry('b')],
      { registry, adapters: [adapter] },
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.property).toBe('accountId');
    expect(dangling[0]?.verdict.status).toBe('not_found');
    expect(unavailable).toEqual([]);
  });

  it('both lists empty when the batch is fully consistent', async () => {
    const { registry, adapter } = fixture();
    const result = await verifyReferences([new LedgerEntry('a')], {
      registry,
      adapters: [adapter],
    });
    expect(result.dangling).toEqual([]);
    expect(result.unavailable).toEqual([]);
  });

  it('classifies a transient store outage as UNAVAILABLE, never dangling (no false remediation)', async () => {
    const { registry } = fixture();
    const down: CrossStoreAdapter = {
      store: 'canonical',
      findMany: () => Promise.reject(new Error('canonical is down')),
    };
    const { dangling, unavailable } = await verifyReferences([new LedgerEntry('a')], {
      registry,
      adapters: [down],
    });
    expect(dangling).toEqual([]); // a blip must NOT be reported as a broken reference
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.verdict.status).toBe('unavailable');
  });

  it('reports a drifted required field as dangling (invalid) instead of throwing — sweep never crashes', async () => {
    const { registry, adapter } = fixture();
    const drifted = Object.assign(new RequiredLedgerEntry(), { accountId: null });
    const { dangling } = await verifyReferences([drifted], { registry, adapters: [adapter] });
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.verdict.status).toBe('invalid');
  });
});

describe('warnNonAppendOnlyTargets', () => {
  it('warns once per non-append-only target and returns the count', () => {
    const registry = new ReferenceRegistry()
      .register({ ...REF, targetIsAppendOnly: true })
      .register({ store: 'canonical', table: 'sessions', column: 'id' }); // NOT append-only
    const messages: string[] = [];
    const count = warnNonAppendOnlyTargets(registry, (m) => messages.push(m));
    expect(count).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('canonical.sessions.id');
  });

  it('warns nothing when every target is append-only', () => {
    const { registry } = fixture();
    const messages: string[] = [];
    expect(warnNonAppendOnlyTargets(registry, (m) => messages.push(m))).toBe(0);
    expect(messages).toEqual([]);
  });
});
