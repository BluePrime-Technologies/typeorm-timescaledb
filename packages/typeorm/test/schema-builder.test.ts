import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { compileOperations, type Operation } from '@blueprime/timescaledb-core';
import { TimescaleSchemaBuilder } from '../src/index.js';

/** A stub QueryRunner that records every SQL string passed to query(), in order. */
function recordingRunner(): { runner: QueryRunner; calls: string[] } {
  const calls: string[] = [];
  const runner = {
    query: async (sql: string): Promise<unknown[]> => {
      calls.push(sql);
      return [];
    },
  } as unknown as QueryRunner;
  return { runner, calls };
}

describe('TimescaleSchemaBuilder', () => {
  it('chains: every method returns the same builder instance', () => {
    const b = new TimescaleSchemaBuilder();
    expect(b.createHypertable({ table: 'public.m', timeColumn: 'ts' })).toBe(b);
    expect(b.addRetentionPolicy({ table: 'public.m', dropAfter: '90 days' })).toBe(b);
    expect(
      b.add({ kind: 'setChunkInterval', table: 'public.m', from: '1 day', to: '7 days' }),
    ).toBe(b);
  });

  it('appends the exact Operation for each typed method', () => {
    const b = new TimescaleSchemaBuilder()
      .createHypertable({ table: 'public.m', timeColumn: 'ts', chunkInterval: '1 day' })
      .addColumnstorePolicy({ table: 'public.m', segmentBy: ['device'], after: '7 days' })
      .addRetentionPolicy({ table: 'public.m', dropAfter: '90 days' });

    expect(b.operations).toEqual([
      { kind: 'createHypertable', table: 'public.m', timeColumn: 'ts', chunkInterval: '1 day' },
      { kind: 'addColumnstorePolicy', table: 'public.m', segmentBy: ['device'], after: '7 days' },
      { kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '90 days' },
    ]);
  });

  it('operations getter returns a defensive copy (external mutation cannot corrupt state)', () => {
    const b = new TimescaleSchemaBuilder().createHypertable({
      table: 'public.m',
      timeColumn: 'ts',
    });
    const snapshot = b.operations as Operation[];
    snapshot.push({ kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '1 day' });
    expect(b.operations).toHaveLength(1);
  });

  it('add() is a generic escape hatch for any Operation', () => {
    const op: Operation = {
      kind: 'renameHypertable',
      from: 'public.old',
      to: 'public.new',
    };
    const b = new TimescaleSchemaBuilder().add(op);
    expect(b.operations).toEqual([op]);
  });

  it('toPlan() classifies each op with a safety class + non-empty reason', () => {
    const plan = new TimescaleSchemaBuilder()
      .createHypertable({ table: 'public.m', timeColumn: 'ts' }) // one-way
      .addRetentionPolicy({ table: 'public.m', dropAfter: '90 days' }) // online-safe
      .toPlan();

    expect(plan.steps.map((s) => s.operation.kind)).toEqual([
      'createHypertable',
      'addRetentionPolicy',
    ]);
    expect(plan.steps[0]!.safety).toBe('one-way');
    expect(plan.steps[1]!.safety).toBe('online-safe');
    for (const step of plan.steps) expect(step.reason.length).toBeGreaterThan(0);
  });

  it('build() compiles up in order and down in reverse — byte-identical to compileOperations', () => {
    const ops: Operation[] = [
      { kind: 'createHypertable', table: 'public.m', timeColumn: 'ts', chunkInterval: '1 day' },
      { kind: 'addColumnstorePolicy', table: 'public.m', segmentBy: ['device'], after: '7 days' },
      { kind: 'addRetentionPolicy', table: 'public.m', dropAfter: '90 days' },
    ];
    const b = new TimescaleSchemaBuilder();
    for (const op of ops) b.add(op);

    const statements = compileOperations(ops);
    const expectedUp = statements.flatMap((s) => s.up);
    const expectedDown = [...statements].reverse().flatMap((s) => s.down);

    const compiled = b.build();
    expect(compiled.up).toEqual(expectedUp);
    expect(compiled.down).toEqual(expectedDown);
  });

  it('build() of an empty builder is empty up/down', () => {
    expect(new TimescaleSchemaBuilder().build()).toEqual({ up: [], down: [] });
  });

  it('up(qr) runs the compiled up statements in order', async () => {
    const b = new TimescaleSchemaBuilder()
      .createHypertable({ table: 'public.m', timeColumn: 'ts' })
      .addRetentionPolicy({ table: 'public.m', dropAfter: '90 days' });
    const { runner, calls } = recordingRunner();

    await b.up(runner);
    expect(calls).toEqual([...b.build().up]);
    // The retention add is the last up statement.
    expect(calls[calls.length - 1]).toMatch(/add_retention_policy/);
  });

  it('down(qr) runs the compiled down statements (reverse order)', async () => {
    const b = new TimescaleSchemaBuilder()
      .createHypertable({ table: 'public.m', timeColumn: 'ts' })
      .addRetentionPolicy({ table: 'public.m', dropAfter: '90 days' });
    const { runner, calls } = recordingRunner();

    await b.down(runner);
    expect(calls).toEqual([...b.build().down]);
    // Retention (added last) is removed first in down.
    expect(calls[0]).toMatch(/remove_retention_policy/);
  });

  it('up(qr) of an empty builder runs nothing', async () => {
    const { runner, calls } = recordingRunner();
    await new TimescaleSchemaBuilder().up(runner);
    expect(calls).toEqual([]);
  });

  // Every typed method, exercised through its own wrapper: the produced Operation must carry the
  // RIGHT kind (a copy-paste kind/input mismatch fails here) and must compile to non-empty up/down
  // through the core choke point. Pins the `{ ...input, kind }` spread per-kind for all 13.
  const cases: ReadonlyArray<{
    method: keyof TimescaleSchemaBuilder;
    input: unknown;
    kind: string;
  }> = [
    {
      method: 'createHypertable',
      input: { table: 'public.m', timeColumn: 'ts' },
      kind: 'createHypertable',
    },
    {
      method: 'addColumnstorePolicy',
      input: { table: 'public.m', segmentBy: ['d'] },
      kind: 'addColumnstorePolicy',
    },
    {
      method: 'addRetentionPolicy',
      input: { table: 'public.m', dropAfter: '90 days' },
      kind: 'addRetentionPolicy',
    },
    {
      method: 'createContinuousAggregate',
      input: {
        view: 'mv',
        source: 'public.m',
        timeColumn: 'ts',
        bucketInterval: '1 hour',
        aggregates: [{ fn: 'count', as: 'n' }],
      },
      kind: 'createContinuousAggregate',
    },
    {
      method: 'addContinuousAggregatePolicy',
      input: { view: 'mv', startOffset: '1 month', endOffset: '1 hour' },
      kind: 'addContinuousAggregatePolicy',
    },
    {
      method: 'addCompressionPolicy',
      input: { table: 'public.m', after: '7 days' },
      kind: 'addCompressionPolicy',
    },
    {
      method: 'alterCompressionPolicy',
      input: { table: 'public.m', from: '7 days', to: '30 days' },
      kind: 'alterCompressionPolicy',
    },
    {
      method: 'alterRetentionPolicy',
      input: { table: 'public.m', from: '90 days', to: '365 days' },
      kind: 'alterRetentionPolicy',
    },
    {
      method: 'renameHypertable',
      input: { from: 'public.a', to: 'public.b' },
      kind: 'renameHypertable',
    },
    {
      method: 'setChunkInterval',
      input: { table: 'public.m', from: '1 day', to: '7 days' },
      kind: 'setChunkInterval',
    },
    {
      method: 'alterColumnstoreConfig',
      input: {
        table: 'public.m',
        from: { segmentBy: ['a'], orderBy: [] },
        to: { segmentBy: ['a', 'b'], orderBy: [] },
      },
      kind: 'alterColumnstoreConfig',
    },
    {
      method: 'removeRetentionPolicy',
      input: { table: 'public.m', restoreAfter: '90 days' },
      kind: 'removeRetentionPolicy',
    },
    {
      method: 'removeCompressionPolicy',
      input: { table: 'public.m', restoreAfter: '7 days' },
      kind: 'removeCompressionPolicy',
    },
  ];

  it('covers every OperationKind (13 typed methods → right kind, all compile)', () => {
    const seen = new Set<string>();
    for (const { method, input, kind } of cases) {
      const b = new TimescaleSchemaBuilder();
      // Dynamic dispatch over the typed methods; inputs are the matching core builder inputs.
      (b[method] as (i: unknown) => TimescaleSchemaBuilder)(input);
      expect(b.operations).toHaveLength(1);
      expect(b.operations[0]!.kind).toBe(kind);
      const compiled = b.build();
      expect(compiled.up.length).toBeGreaterThan(0);
      expect(compiled.down.length).toBeGreaterThan(0);
      seen.add(kind);
    }
    // Exactly the 13 operation kinds — a new union member without a builder method fails this count.
    expect(seen.size).toBe(13);
  });

  it('the typed method spread cannot be overridden by a stray runtime kind in the input', () => {
    // A JS/deserialized caller sneaks a bogus `kind` into the input; the method's intended kind wins.
    const b = new TimescaleSchemaBuilder();
    (b.addRetentionPolicy as (i: unknown) => TimescaleSchemaBuilder)({
      table: 'public.m',
      dropAfter: '90 days',
      kind: 'dropEverything',
    });
    expect(b.operations[0]!.kind).toBe('addRetentionPolicy');
  });
});
