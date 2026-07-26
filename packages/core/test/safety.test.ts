import { describe, expect, it } from 'vitest';
import {
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
    safety: 'online-safe', // re-schedules future drops, deletes no data at apply, reversible
  },
  {
    operation: { kind: 'renameHypertable', from: 'public.old_m', to: 'public.m' },
    safety: 'online-safe', // catalog-only ALTER TABLE ... RENAME TO, cleanly reversible
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
