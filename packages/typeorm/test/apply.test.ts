import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  classifyOperation,
  compilePlan,
  TimescaleError,
  type Operation,
  type Plan,
} from '@blueprime/timescaledb-core';
import { applyDirect } from '../src/index.js';

// Build a real, safety-classified Plan from operations (safety comes from classifyOperation).
const planOf = (...ops: Operation[]): Plan => ({
  steps: ops.map((operation) => ({ operation, ...classifyOperation(operation) })),
});

const CREATE: Operation = { kind: 'createHypertable', table: 'public.m', timeColumn: 'ts' };
const RETENTION: Operation = {
  kind: 'addRetentionPolicy',
  table: 'public.m',
  dropAfter: '90 days',
};

/**
 * A stub DataSource whose QueryRunner records its full lifecycle. `failOn` makes query() throw when a
 * statement contains that substring (to exercise rollback).
 */
function stub(opts: { failOn?: string; failConnect?: boolean; failRelease?: boolean } = {}): {
  ds: DataSource;
  events: string[];
  queries: string[];
  created: () => number;
} {
  const { failOn, failConnect, failRelease } = opts;
  const events: string[] = [];
  const queries: string[] = [];
  let txActive = false;
  let createdCount = 0;
  const runner = {
    connect: async (): Promise<void> => {
      events.push('connect');
      if (failConnect === true) throw new Error('connect failed');
    },
    startTransaction: async (): Promise<void> => {
      events.push('start');
      txActive = true;
    },
    commitTransaction: async (): Promise<void> => {
      events.push('commit');
      txActive = false;
    },
    rollbackTransaction: async (): Promise<void> => {
      events.push('rollback');
      txActive = false;
    },
    release: async (): Promise<void> => {
      events.push('release');
      if (failRelease === true) throw new Error('release failed');
    },
    get isTransactionActive(): boolean {
      return txActive;
    },
    query: async (sql: string): Promise<unknown[]> => {
      events.push('query');
      queries.push(sql);
      if (failOn !== undefined && sql.includes(failOn)) throw new Error('boom');
      return [];
    },
  };
  const ds = {
    createQueryRunner: () => {
      createdCount++;
      return runner;
    },
  } as unknown as DataSource;
  return { ds, events, queries, created: () => createdCount };
}

describe('applyDirect', () => {
  it('runs up in a transaction: connect → start → query×N → commit → release', async () => {
    const plan = planOf(CREATE, RETENTION);
    const { ds, events, queries } = stub();
    const result = await applyDirect(ds, plan);

    const expectedUp = compilePlan(plan).up;
    expect(queries).toEqual([...expectedUp]);
    expect(events).toEqual([
      'connect',
      'start',
      ...expectedUp.map(() => 'query'),
      'commit',
      'release',
    ]);
    expect(result).toEqual({ direction: 'up', statements: expectedUp, stepCount: 2 });
  });

  it('runs down (reverse order) when direction is down', async () => {
    const plan = planOf(CREATE, RETENTION);
    const { ds, queries } = stub();
    const result = await applyDirect(ds, plan, { direction: 'down' });

    const expectedDown = compilePlan(plan).down;
    expect(queries).toEqual([...expectedDown]);
    expect(result.direction).toBe('down');
    // Retention (added last) is removed first in down.
    expect(queries[0]).toMatch(/remove_retention_policy/);
  });

  it('skips the transaction when transaction:false', async () => {
    const plan = planOf(RETENTION);
    const { ds, events } = stub();
    await applyDirect(ds, plan, { transaction: false });
    expect(events).toEqual(['connect', 'query', 'release']);
    expect(events).not.toContain('start');
    expect(events).not.toContain('commit');
  });

  // The gate classifies AUTHORITATIVELY from the operation (classifyOperation), not the plan's
  // caller-supplied `step.safety` — so a mislabeled plan cannot slip a dangerous op past it. An
  // unknown discriminant is the operation that classifies to `refuse-by-default` (safety.ts fallback).
  const REFUSE: Operation = { kind: 'dropEverything' } as unknown as Operation;

  it('refuses a refuse-by-default op BEFORE touching the DB (gate ignores mislabeled step.safety)', async () => {
    // Deliberately MISLABEL it online-safe in the plan metadata — the authoritative gate must still fire.
    const plan: Plan = {
      steps: [{ operation: REFUSE, safety: 'online-safe', reason: 'mislabeled (test)' }],
    };
    const { ds, events, created } = stub();

    await expect(applyDirect(ds, plan)).rejects.toBeInstanceOf(TimescaleError);
    // Nothing ran: no query runner was even created.
    expect(created()).toBe(0);
    expect(events).toEqual([]);
  });

  it('bypasses the gate when allowRefuseByDefault is set (proceeds past it to compile)', async () => {
    const plan: Plan = {
      steps: [{ operation: REFUSE, safety: 'refuse-by-default', reason: 'dangerous (test)' }],
    };
    const { ds, created } = stub();
    // Gate is bypassed → it proceeds to compilePlan, which rejects the unknown kind. The point is the
    // error is the COMPILE error (mentions the kind), NOT the refuse-by-default gate error.
    await expect(applyDirect(ds, plan, { allowRefuseByDefault: true })).rejects.toThrow(
      /dropEverything/,
    );
    expect(created()).toBe(0); // compile throws before any runner is created
  });

  it('rolls back and rethrows when a statement fails mid-batch', async () => {
    const plan = planOf(CREATE, RETENTION);
    const { ds, events } = stub({ failOn: 'add_retention_policy' }); // fail on the retention statement

    await expect(applyDirect(ds, plan)).rejects.toThrow('boom');
    expect(events).toContain('rollback');
    expect(events).not.toContain('commit');
    // Connection always released, even on failure.
    expect(events[events.length - 1]).toBe('release');
  });

  it('is a no-op for an empty plan (no transaction, no query runner)', async () => {
    const { ds, events, created } = stub();
    const result = await applyDirect(ds, { steps: [] });
    expect(created()).toBe(0);
    expect(events).toEqual([]);
    expect(result).toEqual({ direction: 'up', statements: [], stepCount: 0 });
  });

  it('releases the connection even when connect() fails', async () => {
    const plan = planOf(RETENTION);
    const { ds, events } = stub({ failConnect: true });
    await expect(applyDirect(ds, plan)).rejects.toThrow('connect failed');
    // No transaction started, but the runner was created → must be released.
    expect(events).toContain('release');
    expect(events).not.toContain('start');
    expect(events).not.toContain('query');
  });

  it('with transaction:false, a mid-batch failure rethrows without rollback but still releases', async () => {
    const plan = planOf(CREATE, RETENTION);
    const { ds, events } = stub({ failOn: 'add_retention_policy' });
    await expect(applyDirect(ds, plan, { transaction: false })).rejects.toThrow('boom');
    expect(events).not.toContain('rollback'); // no transaction to roll back
    expect(events).not.toContain('commit');
    expect(events[events.length - 1]).toBe('release'); // always released
  });

  it('a release() failure does NOT mask the primary error (query error wins)', async () => {
    const plan = planOf(CREATE, RETENTION);
    const { ds } = stub({ failOn: 'add_retention_policy', failRelease: true });
    // Both query and release throw — the caller must still see the real cause ('boom'), not 'release failed'.
    await expect(applyDirect(ds, plan)).rejects.toThrow('boom');
  });

  it('surfaces a release() failure when the work itself succeeded', async () => {
    const plan = planOf(RETENTION);
    const { ds } = stub({ failRelease: true });
    await expect(applyDirect(ds, plan)).rejects.toThrow('release failed');
  });
});
