import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TimescaleError, TimescaleErrorCode } from '../src/index.js';
import { addJob, alterJob, deleteJob, getJobStats, runJob } from '../src/runtime/info.js';

/**
 * Unit coverage for the user-defined action jobs API (`info.ts`). These exercise the
 * pure-logic guards and the SQL/parameter assembly WITHOUT a live TimescaleDB — the
 * happy-path behaviour against a real catalog is covered by `info.integration.test.ts`
 * (which is `skipIf(!IMAGE)`, so it does not run in the default suite). Per the repo's
 * testing rule, the validation/edge-case paths must have non-integration coverage.
 */

interface Captured {
  sql: string;
  params: unknown[] | undefined;
}

/** A DataSource whose `query` records every call and returns a canned result. */
function recordingDataSource(result: unknown[] = []): {
  ds: DataSource;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const ds = {
    query: async (sql: string, params?: unknown[]): Promise<unknown[]> => {
      calls.push({ sql, params });
      return result;
    },
  } as unknown as DataSource;
  return { ds, calls };
}

/** A DataSource whose `query` FAILS the test if it is ever called (guard must fire first). */
function neverQueriedDataSource(): DataSource {
  return {
    query: async (): Promise<unknown[]> => {
      throw new Error('query() must not be reached — a guard should have thrown first');
    },
  } as unknown as DataSource;
}

function expectInvalidArg(fn: () => Promise<unknown>): Promise<void> {
  return fn().then(
    () => {
      throw new Error('expected TimescaleError(INVALID_ARGUMENT)');
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(TimescaleError);
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
    },
  );
}

describe('addJob', () => {
  it('rejects an empty / whitespace procedure name before touching the database', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() => addJob(ds, '', { scheduleInterval: '1 hour' }));
    await expectInvalidArg(() => addJob(ds, '   ', { scheduleInterval: '1 hour' }));
  });

  it('rejects a missing scheduleInterval before touching the database', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() =>
      addJob(ds, 'my_proc', { scheduleInterval: '' } as { scheduleInterval: string }),
    );
  });

  it('binds the trimmed proc as $1::regproc and the interval as $2::interval', async () => {
    const { ds, calls } = recordingDataSource([{ job_id: 42 }]);
    const id = await addJob(ds, '  my_schema.my_proc  ', { scheduleInterval: '1 hour' });
    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('add_job($1::regproc, $2::interval)');
    expect(calls[0]?.params).toEqual(['my_schema.my_proc', '1 hour']);
  });

  it('appends config / initialStart / fixedSchedule only when provided, in order', async () => {
    const { ds, calls } = recordingDataSource([{ job_id: 7 }]);
    const start = new Date('2026-01-01T00:00:00Z');
    await addJob(ds, 'p', {
      scheduleInterval: '30 minutes',
      config: { foo: 'bar' },
      initialStart: start,
      fixedSchedule: true,
    });
    const { sql, params } = calls[0] ?? { sql: '', params: [] };
    expect(sql).toContain('config => $3::jsonb');
    expect(sql).toContain('initial_start => $4::timestamptz');
    expect(sql).toContain('fixed_schedule => $5::boolean');
    expect(params).toEqual(['p', '30 minutes', JSON.stringify({ foo: 'bar' }), start, true]);
  });

  it('throws when add_job returns no job id', async () => {
    const { ds } = recordingDataSource([{ job_id: null }]);
    await expectInvalidArg(() => addJob(ds, 'p', { scheduleInterval: '1 hour' }));
  });
});

describe('alterJob', () => {
  it('rejects a non-positive job id before touching the database', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() => alterJob(ds, 0, { scheduled: false }));
    await expectInvalidArg(() => alterJob(ds, -1, { scheduled: false }));
    await expectInvalidArg(() => alterJob(ds, 1.5, { scheduled: false }));
  });

  it('rejects a negative / non-integer maxRetries before touching the database', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() => alterJob(ds, 1, { maxRetries: -1 }));
    await expectInvalidArg(() => alterJob(ds, 1, { maxRetries: 2.5 }));
  });

  it('throws when no change is supplied (only the id would be sent)', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() => alterJob(ds, 1, {}));
  });

  it('sends only the fields that are set, with the right casts and $1 = id', async () => {
    const { ds, calls } = recordingDataSource([{ alter_job: 1 }]);
    await alterJob(ds, 9, {
      scheduleInterval: '2 hours',
      config: { a: 1 },
      scheduled: false,
      maxRetries: 3,
    });
    const { sql, params } = calls[0] ?? { sql: '', params: [] };
    expect(sql).toContain('alter_job($1');
    expect(sql).toContain('schedule_interval => $2::interval');
    expect(sql).toContain('config => $3::jsonb');
    expect(sql).toContain('scheduled => $4::boolean');
    expect(sql).toContain('max_retries => $5::integer');
    // Omitted fields must not appear.
    expect(sql).not.toContain('max_runtime');
    expect(sql).not.toContain('retry_period');
    expect(params).toEqual([9, '2 hours', JSON.stringify({ a: 1 }), false, 3]);
  });
});

describe('deleteJob / runJob / getJobStats', () => {
  it('all reject a non-positive job id before touching the database', async () => {
    const ds = neverQueriedDataSource();
    await expectInvalidArg(() => deleteJob(ds, 0));
    await expectInvalidArg(() => runJob(ds, -5));
    await expectInvalidArg(() => getJobStats(ds, 0));
  });

  it('getJobStats returns null for an unknown job id', async () => {
    const { ds } = recordingDataSource([]);
    expect(await getJobStats(ds, 123)).toBeNull();
  });

  it('deleteJob binds the id as $1', async () => {
    const { ds, calls } = recordingDataSource([]);
    await deleteJob(ds, 11);
    expect(calls[0]?.sql).toContain('delete_job($1)');
    expect(calls[0]?.params).toEqual([11]);
  });
});
