import { describe, expect, it } from 'vitest';
import {
  ANALYZERS,
  classifyOperation,
  formatLintFindings,
  lintPlan,
  type Operation,
  type Plan,
} from '../src/index.js';

const plan = (...operations: Operation[]): Plan => ({
  steps: operations.map((operation) => ({ operation, ...classifyOperation(operation) })),
});
const codes = (p: Plan): string[] => lintPlan(p).map((f) => f.code);

describe('lintPlan — analyzer set', () => {
  it('says nothing about an empty plan', () => {
    expect(lintPlan({ steps: [] })).toEqual([]);
    expect(formatLintFindings([])).toBe('No lint findings.');
  });

  it('TSDB002: flags a rename as breaking clients on the old name', () => {
    const found = lintPlan(plan({ kind: 'renameHypertable', from: 'public.a', to: 'public.b' }));
    const f = found.find((x) => x.code === 'TSDB002');
    expect(f?.severity).toBe('error');
    // The value is the CONSEQUENCE, not the restatement — a rename is safe for the database and
    // fatal for an app still querying the old name, which nothing else in the engine looks at.
    expect(f?.detail).toMatch(/ACCESS EXCLUSIVE/);
    expect(f?.detail).toMatch(/still referencing public\.a fails/);
    expect(f?.remediation).toMatch(/same window/);
  });

  it('TSDB003: flags that a columnstore change leaves existing chunks stale', () => {
    const f = lintPlan(
      plan({
        kind: 'alterColumnstoreConfig',
        table: 'public.m',
        from: { segmentBy: ['a'], orderBy: [] },
        to: { segmentBy: ['b'], orderBy: [] },
      }),
    ).find((x) => x.code === 'TSDB003');
    // The exact silent-wrongness the recompression planner exists for — named, with the remedy.
    expect(f?.detail).toMatch(/drift check will look clean while the stored data does not match/);
    expect(f?.remediation).toMatch(/planRecompression/);
  });

  it('TSDB004: corrects the common belief that a chunk-interval change is retroactive', () => {
    const f = lintPlan(
      plan({ kind: 'setChunkInterval', table: 'public.m', from: '1 day', to: '1 hour' }),
    ).find((x) => x.code === 'TSDB004');
    expect(f?.severity).toBe('info');
    expect(f?.detail).toMatch(/existing chunks keep 1 day/);
  });

  it('TSDB009: catches a step targeting a name renamed EARLIER in the same plan', () => {
    // The plan-level catch a per-operation classification structurally cannot make.
    const found = lintPlan(
      plan(
        { kind: 'renameHypertable', from: 'public.old', to: 'public.new' },
        { kind: 'addRetentionPolicy', table: 'public.old', dropAfter: '30 days' },
      ),
    );
    const f = found.find((x) => x.code === 'TSDB009');
    expect(f?.severity).toBe('error');
    expect(f?.detail).toMatch(/no longer exists and the statement will fail/);
  });

  it('TSDB009: does NOT fire when the step precedes the rename', () => {
    // Order is the whole point of the rule; firing regardless would make it noise.
    const found = lintPlan(
      plan(
        { kind: 'addRetentionPolicy', table: 'public.old', dropAfter: '30 days' },
        { kind: 'renameHypertable', from: 'public.old', to: 'public.new' },
      ),
    );
    expect(found.map((f) => f.code)).not.toContain('TSDB009');
  });

  it('TSDB010: reports a repeated object ONCE, not per step', () => {
    const found = lintPlan(
      plan(
        { kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '30 days' },
        { kind: 'setChunkInterval', table: 'public.m', from: '1 day', to: '1 hour' },
        { kind: 'addCompressionPolicy', table: 'public.m', after: '7 days' },
      ),
    ).filter((f) => f.code === 'TSDB010');
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toMatch(/3 steps/);
  });

  it('orders findings most-severe first, then by step', () => {
    const found = lintPlan(
      plan(
        { kind: 'setChunkInterval', table: 'public.m', from: '1 day', to: '1 hour' }, // info
        { kind: 'renameHypertable', from: 'public.a', to: 'public.b' }, // error
      ),
    );
    expect(found[0]?.severity).toBe('error');
  });

  it('every analyzer has a unique, stable code', () => {
    const all = ANALYZERS.map((a) => a.code);
    expect(new Set(all).size).toBe(all.length);
    // TSDB005 is deliberately absent — reserved for the chunk-rewrite rule arriving with #195. A
    // reused code would mean two different things across versions, which is worse than a gap.
    expect(all).not.toContain('TSDB005');
    expect(all.every((c) => /^TSDB\d{3}$/.test(c))).toBe(true);
  });

  it('does not fire on a plain, unremarkable plan', () => {
    // A linter that flags everything gets ignored, which is the same as not having one.
    const quiet = plan({
      kind: 'createHypertable',
      table: 'public.m',
      timeColumn: 'ts',
      chunkInterval: '1 day',
    });
    expect(codes(quiet).filter((c) => c !== 'TSDB010')).toEqual([]);
  });
});

describe('formatLintFindings', () => {
  it('states that findings do NOT block, so a clean lint is not read as approval', () => {
    const text = formatLintFindings(
      lintPlan(plan({ kind: 'renameHypertable', from: 'a', to: 'b' })),
    );
    expect(text).toMatch(/do not block/);
    expect(text).toMatch(/safety gate/);
    expect(text).toMatch(/✖ TSDB002/);
    expect(text).toMatch(/→ /); // the remediation is rendered, not just stored
  });
});
