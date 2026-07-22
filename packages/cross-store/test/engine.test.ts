import { describe, expect, it } from 'vitest';
import {
  ReferenceRegistry,
  resolveReferences,
  assertAllResolved,
  CrossStoreError,
  CrossStoreErrorCode,
} from '../src/index.js';
import type {
  CrossStoreAdapter,
  FindManyInput,
  ReferenceCheck,
  SnapshotRow,
  ValidatorMap,
} from '../src/index.js';

const REF = { store: 'canonical', table: 'canonical_records', column: 'id' };

function registry(): ReferenceRegistry {
  return new ReferenceRegistry().register({
    ...REF,
    scopeColumns: ['workspace_id'],
    targetIsAppendOnly: true,
  });
}

/** An in-memory adapter that records each findMany call and returns seeded rows. */
class FakeAdapter implements CrossStoreAdapter {
  readonly calls: FindManyInput[] = [];
  constructor(
    readonly store: string,
    private readonly rows: SnapshotRow[],
    private readonly opts: { throwOnFetch?: boolean; rejectWith?: unknown } = {},
  ) {}

  findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    this.calls.push(input);
    if (this.opts.rejectWith !== undefined) return Promise.reject(this.opts.rejectWith);
    if (this.opts.throwOnFetch) return Promise.reject(new Error('connection refused'));
    const ids = new Set(input.ids.map((v) => String(v)));
    const matched = this.rows.filter((r) => {
      if (!ids.has(String(r[input.column]))) return false;
      if (input.scope) {
        for (const [col, val] of Object.entries(input.scope)) {
          if (String(r[col]) !== String(val)) return false;
        }
      }
      return true;
    });
    return Promise.resolve(matched);
  }
}

function check(value: unknown, extra: Partial<ReferenceCheck> = {}): ReferenceCheck {
  return { ref: REF, value, ...extra };
}

describe('resolveReferences', () => {
  it('resolves an existing reference (happy path) and exposes the snapshot row', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a', workspace_id: 'w1' }]);
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.ok).toBe(true);
    expect(verdict?.status).toBe('resolved');
    expect(verdict?.row).toEqual({ id: 'a', workspace_id: 'w1' });
    expect(verdict?.error).toBeUndefined();
  });

  it('reports a genuinely absent reference as not_found (row fetched, missing)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const [verdict] = await resolveReferences([check('ghost')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('not_found');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
  });

  it('reports an adapter throw as unavailable, NOT not_found (availability != correctness)', async () => {
    const adapter = new FakeAdapter('canonical', [], { throwOnFetch: true });
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('unavailable');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.ADAPTER_UNAVAILABLE);
    // the whole group fails as unavailable — never silently "not found"
    expect(verdict?.error?.code).not.toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
  });

  // A permanent "object does not exist" SQL error (undefined table/column/schema) is a mis-declared
  // registry entry. The engine records a `misconfigured` VERDICT (it never throws per-group, so the
  // verifyReferences sweep survives); the write path surfaces it via assertAllResolved (issue #146).
  it.each([
    ['42P01 undefined_table (pg .code)', { code: '42P01' }],
    ['42703 undefined_column (pg .code)', { code: '42703' }],
    ['3F000 invalid_schema (pg .code)', { code: '3F000' }],
    ['lower-case driver code is normalized', { code: '42p01' }],
    ['Prisma P2010 with meta.code', { code: 'P2010', meta: { code: '42P01' } }],
    [
      'Prisma P2010 with code embedded in message',
      {
        code: 'P2010',
        message: 'Raw query failed. Code: `42703`. Message: `column ... does not exist`',
      },
    ],
    [
      'TypeORM QueryFailedError wrapping driverError',
      { name: 'QueryFailedError', driverError: { code: '42P01' } },
    ],
  ])('records a `misconfigured` verdict (not a throw) for %s', async (_label, rejectWith) => {
    const adapter = new FakeAdapter('canonical', [], { rejectWith });
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('misconfigured');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.REFERENCE_MISCONFIGURED);
  });

  it('assertAllResolved throws REFERENCE_MISCONFIGURED on a misconfigured verdict (write path fails loud)', async () => {
    const adapter = new FakeAdapter('canonical', [], { rejectWith: { code: '42P01' } });
    const verdicts = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(() => assertAllResolved(verdicts)).toThrow(
      expect.objectContaining({ code: CrossStoreErrorCode.REFERENCE_MISCONFIGURED }),
    );
  });

  it('does NOT let a data-influenced message forge a misconfigured code (regex gated to Prisma-shaped errors)', async () => {
    // a non-Prisma error (22P02 invalid_text_representation) whose message echoes a hostile value
    // containing "Code: `42P01`" must stay unavailable — never flip to misconfigured.
    const adapter = new FakeAdapter('canonical', [], {
      rejectWith: { code: '22P02', message: 'invalid input syntax for type uuid: "Code: `42P01`"' },
    });
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.status).toBe('unavailable');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.ADAPTER_UNAVAILABLE);
  });

  it.each([
    ['a transient connection error (ECONNREFUSED)', { code: 'ECONNREFUSED' }],
    ['insufficient_privilege 42501 (class 42 but NOT an undefined object)', { code: '42501' }],
    ['syntax_error 42601 (our bug, not a registry misconfig)', { code: '42601' }],
  ])('keeps %s as ADAPTER_UNAVAILABLE, not misconfigured', async (_label, rejectWith) => {
    const adapter = new FakeAdapter('canonical', [], { rejectWith });
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.status).toBe('unavailable');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.ADAPTER_UNAVAILABLE);
    expect(verdict?.error?.code).not.toBe(CrossStoreErrorCode.REFERENCE_MISCONFIGURED);
  });

  it('gates an unregistered target as not_allowed without calling any adapter', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const other = { store: 'canonical', table: 'not_registered', column: 'id' };
    const [verdict] = await resolveReferences([{ ref: other, value: 'a' }], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.status).toBe('not_allowed');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.REFERENCE_NOT_ALLOWED);
    expect(adapter.calls).toHaveLength(0);
  });

  it('gates a non-allowlisted scope column as scope_violation without fetching', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const [verdict] = await resolveReferences([check('a', { scope: { tenant_id: 't1' } })], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdict?.status).toBe('scope_violation');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.SCOPE_VIOLATION);
    expect(adapter.calls).toHaveLength(0);
  });

  it('runs a validator against the fetched row and fails it as validator_failed', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a', kind: 'inflow' }]);
    const validators: ValidatorMap = { mustBeOutflow: (row) => row.kind === 'outflow' };
    const [verdict] = await resolveReferences([check('a', { validators: ['mustBeOutflow'] })], {
      registry: registry(),
      adapters: [adapter],
      validators,
    });
    expect(verdict?.status).toBe('validator_failed');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.VALIDATOR_FAILED);
    expect(verdict?.error?.context.validator).toBe('mustBeOutflow');
    // the fetched row is still exposed for diagnostics
    expect(verdict?.row).toEqual({ id: 'a', kind: 'inflow' });
  });

  it('treats a throwing validator as validator_failed (not a crash)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const validators: ValidatorMap = {
      boom: () => {
        throw new Error('kaboom');
      },
    };
    const [verdict] = await resolveReferences([check('a', { validators: ['boom'] })], {
      registry: registry(),
      adapters: [adapter],
      validators,
    });
    expect(verdict?.status).toBe('validator_failed');
    expect(verdict?.error?.context.validator).toBe('boom');
  });

  it('passes a validator that returns void/true/undefined', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const validators: ValidatorMap = { noop: () => undefined, ok: () => true };
    const [verdict] = await resolveReferences([check('a', { validators: ['noop', 'ok'] })], {
      registry: registry(),
      adapters: [adapter],
      validators,
    });
    expect(verdict?.ok).toBe(true);
  });

  it('batches duplicate + distinct ids into ONE findMany per (store,table,column,scope) group', async () => {
    const adapter = new FakeAdapter('canonical', [
      { id: 'a', workspace_id: 'w1' },
      { id: 'b', workspace_id: 'w1' },
    ]);
    const verdicts = await resolveReferences(
      [
        check('a', { scope: { workspace_id: 'w1' } }),
        check('a', { scope: { workspace_id: 'w1' } }), // duplicate id
        check('b', { scope: { workspace_id: 'w1' } }),
      ],
      { registry: registry(), adapters: [adapter] },
    );
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    // deduped: 'a' appears once even though two checks referenced it
    expect([...adapter.calls[0]!.ids].sort()).toEqual(['a', 'b']);
  });

  it('splits differing scope values into separate findMany calls (bound filter is per-query)', async () => {
    const adapter = new FakeAdapter('canonical', [
      { id: 'a', workspace_id: 'w1' },
      { id: 'a', workspace_id: 'w2' },
    ]);
    const verdicts = await resolveReferences(
      [
        check('a', { scope: { workspace_id: 'w1' } }),
        check('a', { scope: { workspace_id: 'w2' } }),
      ],
      { registry: registry(), adapters: [adapter] },
    );
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  it('matches ids across bigint/number/string driver representations', async () => {
    const numRef = { store: 'canonical', table: 'canonical_records', column: 'id' };
    const reg = new ReferenceRegistry().register(numRef);
    // row from a pg driver hands back the bigint column as a string
    const adapter = new FakeAdapter('canonical', [{ id: '10' }]);
    const verdicts = await resolveReferences(
      [
        { ref: numRef, value: 10 },
        { ref: numRef, value: 10n },
        { ref: numRef, value: '10' },
      ],
      { registry: reg, adapters: [adapter] },
    );
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(adapter.calls).toHaveLength(1); // 10 / 10n / '10' dedupe to one id
  });

  it('preserves input order across mixed outcomes', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const verdicts = await resolveReferences([check('a'), check('missing'), check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(verdicts.map((v) => v.status)).toEqual(['resolved', 'not_found', 'resolved']);
  });

  it('throws INVALID_ARGUMENT (before any fetch) for a store with no adapter', async () => {
    await expect(
      resolveReferences([check('a')], { registry: registry(), adapters: [] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
  });

  it('does NOT require an adapter for a store only referenced by a gated-out check', async () => {
    // the sole check is not_allowed → its store is never needed → no missing-adapter throw
    const other = { store: 'ghoststore', table: 'x', column: 'id' };
    const verdicts = await resolveReferences([{ ref: other, value: 'a' }], {
      registry: registry(),
      adapters: [],
    });
    expect(verdicts[0]?.status).toBe('not_allowed');
  });

  it('throws INVALID_ARGUMENT for two adapters claiming the same store', async () => {
    await expect(
      resolveReferences([check('a')], {
        registry: registry(),
        adapters: [new FakeAdapter('canonical', []), new FakeAdapter('canonical', [])],
      }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
  });

  it('throws INVALID_ARGUMENT when a check names a validator that was not supplied', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    await expect(
      resolveReferences([check('a', { validators: ['missing'] })], {
        registry: registry(),
        adapters: [adapter],
      }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    // pre-flight: it threw before fetching
    expect(adapter.calls).toHaveLength(0);
  });

  it('fetches distinct stores concurrently, one call each', async () => {
    const a = new FakeAdapter('canonical', [{ id: 'a' }]);
    const other = { store: 'timescale', table: 'events', column: 'id' };
    const b = new FakeAdapter('timescale', [{ id: 'e' }]);
    const reg = registry().register(other);
    const verdicts = await resolveReferences([check('a'), { ref: other, value: 'e' }], {
      registry: reg,
      adapters: [a, b],
    });
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
});

describe('resolveReferences — review hardening', () => {
  const REF2 = { store: 'canonical', table: 't', column: 'id' };
  function scopedRegistry(): ReferenceRegistry {
    return new ReferenceRegistry().register({ ...REF2, scopeColumns: ['a', 'b'] });
  }

  it('does NOT merge two different scopes whose naive signatures would collide (injection-proof key)', async () => {
    // {a:'1', b:'2'} vs {a:'1&b=2'} both flatten to "a=1&b=2" under col=val concatenation — they
    // must land in SEPARATE findMany calls, never share one (a wrong-merge = tenant-isolation break).
    const adapter = new FakeAdapter('canonical', [{ id: 'x', a: '1', b: '2' }]);
    const verdicts = await resolveReferences(
      [
        { ref: REF2, value: 'x', scope: { a: '1', b: '2' } },
        { ref: REF2, value: 'x', scope: { a: '1&b=2' } },
      ],
      { registry: scopedRegistry(), adapters: [adapter] },
    );
    expect(adapter.calls).toHaveLength(2);
    // the first check matches the seeded row; the second (different scope) does not
    expect(verdicts[0]?.ok).toBe(true);
    expect(verdicts[1]?.status).toBe('not_found');
  });

  it('groups scope key-order independently (same scope, different key order → one call)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'x', a: '1', b: '2' }]);
    const verdicts = await resolveReferences(
      [
        { ref: REF2, value: 'x', scope: { a: '1', b: '2' } },
        { ref: REF2, value: 'x', scope: { b: '2', a: '1' } },
      ],
      { registry: scopedRegistry(), adapters: [adapter] },
    );
    expect(adapter.calls).toHaveLength(1);
    expect(verdicts.every((v) => v.ok)).toBe(true);
  });

  it('throws INVALID_ARGUMENT for a non-scalar reference value (before any fetch)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    await expect(
      resolveReferences([check({} as unknown)], { registry: registry(), adapters: [adapter] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    await expect(
      resolveReferences([check(null as unknown)], { registry: registry(), adapters: [adapter] }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
    expect(adapter.calls).toHaveLength(0);
  });

  it('throws INVALID_ARGUMENT for a non-scalar scope value', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    await expect(
      resolveReferences([check('a', { scope: { workspace_id: {} as unknown } })], {
        registry: registry(),
        adapters: [adapter],
      }),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.INVALID_ARGUMENT });
  });

  it('treats an empty scope {} as no scope (groups with an unscoped check, one call)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const verdicts = await resolveReferences([check('a', { scope: {} }), check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(adapter.calls).toHaveLength(1);
    expect(verdicts.every((v) => v.ok)).toBe(true);
    // an empty scope object is not passed as a degenerate filter
    expect(adapter.calls[0]?.scope).toBeUndefined();
  });

  it('rejects a validator that returns a falsy non-false value (fail-closed)', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const validators: ValidatorMap = { zero: () => 0 as unknown as boolean };
    const [verdict] = await resolveReferences([check('a', { validators: ['zero'] })], {
      registry: registry(),
      adapters: [adapter],
      validators,
    });
    expect(verdict?.status).toBe('validator_failed');
  });

  it('runs a duplicated validator name only once', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    let runs = 0;
    const validators: ValidatorMap = {
      count: () => {
        runs++;
        return true;
      },
    };
    await resolveReferences([check('a', { validators: ['count', 'count'] })], {
      registry: registry(),
      adapters: [adapter],
      validators,
    });
    expect(runs).toBe(1);
  });

  it('never matches a SQL-NULL-keyed row (a "null" string value does not false-resolve)', async () => {
    // a row whose key column is null must not be indexed/matchable
    const adapter = new FakeAdapter('canonical', [{ id: null }, { id: 'a' }]);
    const [nullish, real] = await resolveReferences([check('null'), check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(nullish?.status).toBe('not_found');
    expect(real?.ok).toBe(true);
  });

  it('freezes the fetched row so a validator cannot mutate the snapshot a sibling check reads', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a', kind: 'inflow' }]);
    const [verdict] = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(Object.isFrozen(verdict?.row)).toBe(true);
  });
});

describe('assertAllResolved', () => {
  it('returns the verdicts unchanged when everything resolved', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const verdicts = await resolveReferences([check('a')], {
      registry: registry(),
      adapters: [adapter],
    });
    expect(assertAllResolved(verdicts)).toBe(verdicts);
  });

  it('throws the first failure error', async () => {
    const adapter = new FakeAdapter('canonical', [{ id: 'a' }]);
    const verdicts = await resolveReferences([check('a'), check('missing')], {
      registry: registry(),
      adapters: [adapter],
    });
    try {
      assertAllResolved(verdicts);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CrossStoreError);
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
    }
  });

  it('does not collapse a malformed unavailable verdict into REFERENCE_NOT_FOUND (fix #5)', () => {
    // a hand-built failed verdict missing its error must NOT be thrown as not_found
    const bogus = [{ check: check('a'), ok: false, status: 'unavailable' as const }];
    try {
      assertAllResolved(bogus);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CrossStoreError).code).toBe(CrossStoreErrorCode.INVALID_ARGUMENT);
      expect((e as CrossStoreError).code).not.toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
    }
  });
});
