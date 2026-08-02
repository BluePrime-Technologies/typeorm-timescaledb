import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { SchemaStateIR } from '@blueprime/timescaledb-core';

// `pullSchema` reads the database through `introspect()`. Mocking that one seam lets every
// behaviour below be driven from a hand-built IR, with no container and no live DB — the real-DB
// round-trip is covered separately in pull.integration.test.ts.
const introspectMock = vi.hoisted(() => vi.fn());
vi.mock('../src/runtime/introspect.js', () => ({ introspect: introspectMock }));

const { parseArgs, CliError, pullCommand } = await import('../src/cli/index.js');
const { pullSchema, formatPullCoverage, PULL_BASE_DDL_CAVEAT } = await import('../src/index.js');

const EMPTY_IR: SchemaStateIR = { hypertables: [], continuousAggregates: [] };

const FULL_IR: SchemaStateIR = {
  hypertables: [
    {
      table: 'public.metrics',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '7 days' }],
      columnstore: { segmentBy: ['device'], orderBy: [] },
      compressionPolicy: { kind: 'compression', after: '7 days' },
      retentionPolicy: { kind: 'retention', after: '90 days' },
    },
  ],
  continuousAggregates: [],
};

/** A database whose retention job is a custom `add_job` the engine cannot interpret. */
const PARTIAL_IR: SchemaStateIR = {
  hypertables: [
    {
      table: 'public.metrics',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'unmanaged', procName: 'custom_purge' },
    },
  ],
  continuousAggregates: [],
};

const fakeDataSource = {} as DataSource;

function collectLogger(): {
  logger: { log: (m: string) => void; error: (m: string) => void };
  out: string[];
} {
  const out: string[] = [];
  return { logger: { log: (m) => out.push(m), error: (m) => out.push(m) }, out };
}

function collectWriter(): {
  writer: { mkdirp: (d: string) => void; write: (p: string, c: string) => void };
  files: { path: string; content: string }[];
} {
  const files: { path: string; content: string }[] = [];
  return {
    writer: { mkdirp: () => undefined, write: (path, content) => files.push({ path, content }) },
    files,
  };
}

beforeEach(() => {
  introspectMock.mockReset();
});

describe('pull — CLI argument contract', () => {
  it('parses the verb and defaults to the ts emitter and migrations dir', () => {
    const a = parseArgs(['pull', '-d', 'ds.ts']);
    expect(a.command).toBe('pull');
    expect(a.output).toBe('ts');
    expect(a.outDir).toBe('migrations');
  });

  it('accepts the shared emit flags', () => {
    const a = parseArgs(['pull', '-d', 'ds.ts', '--output', 'sql', '-o', 'db/ts', '-n', 'Adopted']);
    expect([a.output, a.outDir, a.name]).toEqual(['sql', 'db/ts', 'Adopted']);
  });

  it.each(['--apply', '--allow-drops', '--allow-refused'])(
    'rejects the push-only flag %s — pull is read-only',
    (flag) => {
      // The important property: `pull` can never be handed a flag that would mutate a database.
      expect(() => parseArgs(['pull', '-d', 'ds.ts', flag])).toThrow(CliError);
    },
  );
});

describe('pullSchema', () => {
  it('reproduces a full hypertable and reports complete coverage', async () => {
    introspectMock.mockResolvedValue(FULL_IR);
    const result = await pullSchema(fakeDataSource, { timestamp: 1_760_000_000_000 });

    expect(result.plan.steps.map((s) => s.operation.kind)).toEqual([
      'createHypertable',
      'addColumnstorePolicy',
      'addRetentionPolicy',
    ]);
    expect(result.coverage).toMatchObject({
      hypertablesFound: 1,
      continuousAggregatesFound: 0,
      operationsEmitted: 3,
      complete: true,
    });
    expect(result.migration.up.join('\n')).toContain('create_hypertable');
  });

  it('classifies every step (safety comes from the operation, not the caller)', async () => {
    introspectMock.mockResolvedValue(FULL_IR);
    const { plan } = await pullSchema(fakeDataSource);
    for (const step of plan.steps) {
      expect(step.safety).toBeTruthy();
      expect(step.reason).toBeTruthy();
    }
  });

  it('marks coverage incomplete when an object could not be reproduced', async () => {
    introspectMock.mockResolvedValue(PARTIAL_IR);
    const { coverage } = await pullSchema(fakeDataSource);
    expect(coverage.complete).toBe(false);
    expect(coverage.skipped).toHaveLength(1);
    expect(coverage.skipped[0]?.detail).toContain('custom_purge');
  });

  it('produces an empty migration for a database with no Timescale objects', async () => {
    introspectMock.mockResolvedValue(EMPTY_IR);
    const { migration, coverage } = await pullSchema(fakeDataSource);
    expect(migration.up).toEqual([]);
    expect(coverage).toMatchObject({ operationsEmitted: 0, complete: true });
  });
});

describe('formatPullCoverage', () => {
  it('always states the base-DDL caveat, even on a complete pull', async () => {
    introspectMock.mockResolvedValue(FULL_IR);
    const { coverage } = await pullSchema(fakeDataSource);
    const report = formatPullCoverage(coverage);
    // A coverage report that only listed detected omissions would imply the rest is a full copy.
    expect(report).toContain(PULL_BASE_DDL_CAVEAT);
    expect(report).toContain('not reproduced:             none');
  });

  it('names each skipped object, its facet and its reason', async () => {
    introspectMock.mockResolvedValue(PARTIAL_IR);
    const { coverage } = await pullSchema(fakeDataSource);
    const report = formatPullCoverage(coverage);
    expect(report).toContain('NOT REPRODUCED (1)');
    expect(report).toContain('public.metrics');
    expect(report).toContain('retentionPolicy');
    expect(report).toContain('unmanaged-policy');
  });
});

describe('pullCommand', () => {
  it('writes the migration and returns complete', async () => {
    introspectMock.mockResolvedValue(FULL_IR);
    const { logger, out } = collectLogger();
    const { writer, files } = collectWriter();

    const outcome = await pullCommand(
      fakeDataSource,
      logger,
      { outDir: 'migrations', timestamp: 1_760_000_000_000 },
      writer,
    );

    expect(outcome).toBe('complete');
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('migrations/1760000000000-Timescale.ts');
    expect(files[0]?.content).toContain('implements MigrationInterface');
    expect(out.join('\n')).toContain('Reproduced migration:');
  });

  it('honours --output sql', async () => {
    introspectMock.mockResolvedValue(FULL_IR);
    const { logger } = collectLogger();
    const { writer, files } = collectWriter();

    await pullCommand(
      fakeDataSource,
      logger,
      { outDir: 'db', output: 'sql', name: 'Adopted', timestamp: 1_760_000_000_000 },
      writer,
    );

    expect(files[0]?.path).toBe('db/1760000000000-Adopted.sql');
    expect(files[0]?.content).toContain('create_hypertable');
    expect(files[0]?.content).not.toContain('MigrationInterface');
  });

  it('returns partial and warns loudly when the reproduction is incomplete', async () => {
    introspectMock.mockResolvedValue(PARTIAL_IR);
    const { logger, out } = collectLogger();
    const { writer, files } = collectWriter();

    const outcome = await pullCommand(fakeDataSource, logger, { outDir: 'migrations' }, writer);

    expect(outcome).toBe('partial');
    // The file is still written — a partial migration is useful — but the operator must be told
    // that applying it will NOT reproduce the schema.
    expect(files).toHaveLength(1);
    const text = out.join('\n');
    expect(text).toContain('PARTIAL reproduction');
    expect(text).toContain('custom_purge');
  });

  it('writes no file for a database with no Timescale objects', async () => {
    introspectMock.mockResolvedValue(EMPTY_IR);
    const { logger, out } = collectLogger();
    const { writer, files } = collectWriter();

    const outcome = await pullCommand(fakeDataSource, logger, { outDir: 'migrations' }, writer);

    expect(outcome).toBe('nothing-to-pull');
    expect(files).toEqual([]);
    expect(out.join('\n')).toContain('No TimescaleDB objects found');
  });

  it('distinguishes "nothing there" from "nothing reproducible"', async () => {
    // Every object present but none expressible: no file, but this is NOT a clean empty pull and
    // must not exit 0.
    introspectMock.mockResolvedValue({
      hypertables: [{ table: 'public.m', dimensions: [] }],
      continuousAggregates: [],
    } satisfies SchemaStateIR);
    const { logger, out } = collectLogger();
    const { writer, files } = collectWriter();

    const outcome = await pullCommand(fakeDataSource, logger, { outDir: 'migrations' }, writer);

    expect(outcome).toBe('partial');
    expect(files).toEqual([]);
    expect(out.join('\n')).toContain('Nothing could be reproduced');
  });
});
