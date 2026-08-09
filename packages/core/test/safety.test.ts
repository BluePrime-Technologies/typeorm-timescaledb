import { describe, expect, it } from 'vitest';
import {
  alterRetentionPolicySQL,
  classifyOperation,
  type Operation,
  type OperationKind,
  type SafetyClass,
} from '../src/index.js';

// One representative operation per kind, paired with its expected safety class.
const CASES: ReadonlyArray<{ operation: Operation; safety: SafetyClass }> = [
  {
    operation: { kind: 'createHypertable', table: 'public.m', timeColumn: 'ts' },
    safety: 'one-way', // hypertable conversion — down is a non-destructive notice
  },
  {
    operation: { kind: 'addColumnstorePolicy', table: 'public.m', after: '7 days' },
    safety: 'one-way', // enabling the columnstore is a one-way conversion
  },
  {
    operation: { kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '90 days' },
    safety: 'online-safe', // background job, cleanly reversible
  },
  {
    operation: {
      kind: 'createContinuousAggregate',
      view: 'mv',
      source: 'public.m',
      timeColumn: 'ts',
      bucketInterval: '1 hour',
      aggregates: [{ fn: 'count', as: 'n' }],
    },
    safety: 'one-way', // materialization dropped on down (recomputable only)
  },
  {
    operation: {
      kind: 'addContinuousAggregatePolicy',
      view: 'mv',
      startOffset: '1 month',
      endOffset: '1 hour',
    },
    safety: 'online-safe', // refresh policy is a background job
  },
  {
    operation: { kind: 'addCompressionPolicy', table: 'public.m', after: '7 days' },
    safety: 'online-safe', // policy-only add to an enabled columnstore, no data rewrite
  },
  {
    operation: { kind: 'alterCompressionPolicy', table: 'public.m', from: '7 days', to: '30 days' },
    safety: 'online-safe', // remove-then-add of a background job, reversible
  },
  {
    operation: { kind: 'alterRetentionPolicy', table: 'public.m', from: '90 days', to: '365 days' },
    // LENGTHENING: safe to apply, but down() would restore the shorter 90d and drop everything
    // retained since — so it is one-way, not reversible. The comment here used to say "reversible".
    safety: 'one-way',
  },
  {
    operation: { kind: 'renameHypertable', from: 'public.old_m', to: 'public.m' },
    safety: 'online-safe', // catalog-only ALTER TABLE ... RENAME TO, cleanly reversible
  },
  {
    operation: { kind: 'setChunkInterval', table: 'public.m', from: '1 day', to: '7 days' },
    safety: 'online-safe', // affects only future chunks, no data rewrite, reversible
  },
  {
    operation: {
      kind: 'alterColumnstoreConfig',
      table: 'public.m',
      from: { segmentBy: ['a'], orderBy: [] },
      to: { segmentBy: ['a', 'b'], orderBy: [] },
    },
    safety: 'needs-recompress',
  },
  {
    operation: { kind: 'removeRetentionPolicy', table: 'public.m', restoreAfter: '90 days' },
    safety: 'online-safe', // removing a background job deletes no data; reversible via down re-add
  },
  {
    operation: { kind: 'removeCompressionPolicy', table: 'public.m', restoreAfter: '7 days' },
    safety: 'online-safe', // columnstore stays enabled; only future auto-compression stops; reversible
  },
];

describe('classifyOperation', () => {
  for (const { operation, safety } of CASES) {
    it(`classifies ${operation.kind} as ${safety}`, () => {
      const result = classifyOperation(operation);
      expect(result.safety).toBe(safety);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }

  it('covers every OperationKind (no variant left unclassified)', () => {
    const KINDS: readonly OperationKind[] = [
      'createHypertable',
      'addColumnstorePolicy',
      'addRetentionPolicy',
      'createContinuousAggregate',
      'addContinuousAggregatePolicy',
      'addCompressionPolicy',
      'alterCompressionPolicy',
      'alterRetentionPolicy',
      'renameHypertable',
      'setChunkInterval',
      'alterColumnstoreConfig',
      'removeRetentionPolicy',
      'removeCompressionPolicy',
    ];
    expect([...new Set(CASES.map((c) => c.operation.kind))].sort()).toEqual([...KINDS].sort());
  });

  it('degrades an unknown discriminant to the most conservative refuse-by-default', () => {
    const bogus = { kind: 'dropEverything', table: 'x' } as unknown as Operation;
    const result = classifyOperation(bogus);
    expect(result.safety).toBe('refuse-by-default');
    expect(result.reason).toContain('dropEverything');
  });
});

describe('classifyOperation — retention direction (audit)', () => {
  it('refuses a SHORTENING alterRetentionPolicy (the next run drops previously-retained chunks)', () => {
    const result = classifyOperation({
      kind: 'alterRetentionPolicy',
      table: 'public.m',
      from: '365 days',
      to: '30 days',
    });
    expect(result.safety).toBe('refuse-by-default');
    expect(result.reason).toMatch(/shortens drop_after/);
  });

  it('classifies a LENGTHENING alterRetentionPolicy one-way — its down() would shorten', () => {
    // Previously asserted 'online-safe', and the assertion is part of why it stayed wrong: down()
    // restored `from`, the SHORTER threshold, so rolling back 30d -> 365d re-installed 30d on a
    // hypertable that had been retaining a year and the next retention run dropped ~11 months of
    // chunks. Safe to APPLY but not reversible — which is what 'one-way' means.
    const result = classifyOperation({
      kind: 'alterRetentionPolicy',
      table: 'public.m',
      from: '30 days',
      to: '365 days',
    });
    expect(result.safety).toBe('one-way');
    expect(result.reason).toMatch(/lengthens drop_after/);
    expect(result.reason).toMatch(/NOT reversible/);
  });

  it('does not claim safety it cannot prove — an unparseable threshold is one-way, not online-safe', () => {
    // The old version of this test carried exactly this name and then asserted 'online-safe' for
    // the very case it could not prove. Where the cost of being wrong is deleted data, an
    // unprovable comparison fails closed.
    const result = classifyOperation({
      kind: 'alterRetentionPolicy',
      table: 'public.m',
      from: 'not-an-interval',
      to: '30 days',
    });
    expect(result.safety).toBe('one-way');
    expect(result.reason).toMatch(/cannot be compared/);
  });

  it('down() restores the previous threshold when that LENGTHENS (the safe direction)', () => {
    // Mirror of the bug: shortening 365d -> 30d has a destructive UP (gated refuse-by-default),
    // but its down() lengthens back to 365d and loses nothing, so it must still restore.
    const down = alterRetentionPolicySQL({ table: 'public.m', from: '365 days', to: '30 days' }).down.join(' ');
    expect(down).toMatch(/add_retention_policy/);
    expect(down).toMatch(/365 days/);
  });

  it('down() emits a non-destructive notice instead of reverting when it would SHORTEN', () => {
    const down = alterRetentionPolicySQL({ table: 'public.m', from: '30 days', to: '365 days' }).down.join(' ');
    expect(down).not.toMatch(/add_retention_policy/);
    expect(down).toMatch(/RAISE NOTICE/);
    expect(down).toMatch(/not reverting the retention threshold/);
  });

  it('down() also declines when the two thresholds cannot be compared', () => {
    const down = alterRetentionPolicySQL({ table: 'public.m', from: '30 days', to: '90 days' }).down.join(' ');
    expect(down).toMatch(/RAISE NOTICE/);
  });
});
