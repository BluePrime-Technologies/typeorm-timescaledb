import { describe, expect, it } from 'vitest';
import { classifyOperation, type Operation, type Plan } from '@blueprime/timescaledb-core';
import { formatPlanPreview } from '../src/cli/index.js';

const step = (operation: Operation) => ({ operation, ...classifyOperation(operation) });

describe('formatPlanPreview', () => {
  it('renders one numbered, safety-tagged line per step, plus its reason', () => {
    const plan: Plan = {
      steps: [
        step({ kind: 'renameHypertable', from: 'public.old_events', to: 'public.events' }),
        step({ kind: 'addRetentionPolicy', table: 'public.events', dropAfter: '90 days' }),
      ],
    };
    const text = formatPlanPreview(plan);
    expect(text).toContain('Drift detected — 2 operation(s)');
    expect(text).toContain('1. [online-safe] rename hypertable public.old_events -> public.events');
    expect(text).toContain(
      '2. [online-safe] add retention policy on public.events (drop after 90 days)',
    );
    // the classifier's reason text is surfaced, not just the kind
    expect(text).toContain('catalog-only metadata change');
  });

  it('describes every operation kind (no variant silently falls to "unknown operation")', () => {
    const ops: Operation[] = [
      { kind: 'createHypertable', table: 'public.m', timeColumn: 'ts', chunkInterval: '1 day' },
      { kind: 'addColumnstorePolicy', table: 'public.m', after: '7 days' },
      { kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '90 days' },
      {
        kind: 'createContinuousAggregate',
        view: 'public.mv',
        source: 'public.m',
        timeColumn: 'ts',
        bucketInterval: '1 hour',
        bucketAlias: 'bucket',
        aggregates: [{ fn: 'count', as: 'n' }],
      },
      {
        kind: 'addContinuousAggregatePolicy',
        view: 'public.mv',
        startOffset: '1 month',
        endOffset: '1 hour',
      },
      { kind: 'addCompressionPolicy', table: 'public.m', after: '7 days' },
      { kind: 'alterCompressionPolicy', table: 'public.m', from: '7 days', to: '30 days' },
      { kind: 'alterRetentionPolicy', table: 'public.m', from: '90 days', to: '365 days' },
      { kind: 'renameHypertable', from: 'public.old_m', to: 'public.m' },
    ];
    const plan: Plan = { steps: ops.map(step) };
    const text = formatPlanPreview(plan);
    expect(text).not.toContain('unknown operation');
    for (const op of ops) {
      // every step at least gets its table/view name rendered somewhere in the preview
      const target = 'table' in op ? op.table : 'view' in op ? op.view : undefined;
      if (target) expect(text).toContain(target);
    }
  });
});
