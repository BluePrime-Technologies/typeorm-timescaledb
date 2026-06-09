import 'reflect-metadata';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  generateMigrationFile,
  runMigrationsCommand,
  revertMigrationCommand,
  statusCommand,
  type FileWriter,
  type Logger,
} from '../src/cli/index.js';
import { Hypertable, TimeColumn, HypertablePrimaryKey } from '../src/index.js';

const TS = 1700000000000;

class Metric {}
Hypertable({ chunkInterval: '1 day' })(Metric);
TimeColumn()(Metric.prototype, 'time');
HypertablePrimaryKey()(Metric.prototype, 'time');

function initializedDataSource(): DataSource {
  return {
    isInitialized: true,
    entityMetadatas: [{ target: Metric, tableName: 'metrics', columns: [] }],
  } as unknown as DataSource;
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: { log: (m) => lines.push(m), error: (m) => lines.push(`ERR:${m}`) },
  };
}

describe('generateMigrationFile', () => {
  it('writes the rendered migration to {outDir}/{ts}-{name}.ts', () => {
    const files = new Map<string, string>();
    const dirs: string[] = [];
    const writer: FileWriter = {
      mkdirp: (d) => dirs.push(d),
      write: (p, c) => files.set(p, c),
    };

    const result = generateMigrationFile(
      initializedDataSource(),
      { outDir: 'migrations', timestamp: TS },
      writer,
    );

    const expectedPath = join('migrations', `${TS}-Timescale.ts`);
    expect(result.path).toBe(expectedPath);
    expect(result.className).toBe(`Timescale${TS}`);
    expect(dirs).toContain('migrations');

    const content = files.get(expectedPath);
    expect(content).toContain(`export class Timescale${TS} implements MigrationInterface`);
    expect(content).toContain('create_hypertable');
    expect(content).toContain("import type { MigrationInterface, QueryRunner } from 'typeorm';");
  });

  it('uses a custom name prefix in both the file name and class', () => {
    const files = new Map<string, string>();
    const writer: FileWriter = { mkdirp: () => {}, write: (p, c) => files.set(p, c) };
    const result = generateMigrationFile(
      initializedDataSource(),
      { outDir: 'm', name: 'InitHypertables', timestamp: TS },
      writer,
    );
    expect(result.path).toBe(join('m', `${TS}-InitHypertables.ts`));
    expect(result.className).toBe(`InitHypertables${TS}`);
  });
});

describe('runMigrationsCommand', () => {
  it('reports applied migrations', async () => {
    const { logger, lines } = recordingLogger();
    const ds = {
      runMigrations: async () => [{ name: 'CreateMetrics1700000000000' }],
    } as unknown as DataSource;
    await runMigrationsCommand(ds, logger);
    expect(lines[0]).toContain('Applied 1 migration(s)');
    expect(lines[0]).toContain('CreateMetrics1700000000000');
  });

  it('reports when nothing is pending', async () => {
    const { logger, lines } = recordingLogger();
    const ds = { runMigrations: async () => [] } as unknown as DataSource;
    await runMigrationsCommand(ds, logger);
    expect(lines[0]).toBe('No pending migrations.');
  });
});

describe('revertMigrationCommand', () => {
  it('calls undoLastMigration and logs', async () => {
    const { logger, lines } = recordingLogger();
    let called = false;
    const ds = {
      undoLastMigration: async () => {
        called = true;
      },
    } as unknown as DataSource;
    await revertMigrationCommand(ds, logger);
    expect(called).toBe(true);
    expect(lines[0]).toContain('Reverted');
  });
});

describe('statusCommand', () => {
  it('returns and reports pending state', async () => {
    const { logger, lines } = recordingLogger();
    const pendingDs = { showMigrations: async () => true } as unknown as DataSource;
    expect(await statusCommand(pendingDs, logger)).toBe(true);
    expect(lines[0]).toContain('pending');

    const cleanDs = { showMigrations: async () => false } as unknown as DataSource;
    const { logger: l2, lines: lines2 } = recordingLogger();
    expect(await statusCommand(cleanDs, l2)).toBe(false);
    expect(lines2[0]).toContain('applied');
  });
});
