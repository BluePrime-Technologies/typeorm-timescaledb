import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { generateTimescaleMigration, renderTimescaleMigration } from '../migrations/index.js';

/** Minimal output sink — injectable so commands are testable without touching the console. */
export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

/** Side-effecting file operations, injectable for tests. */
export interface FileWriter {
  mkdirp(dir: string): void;
  write(path: string, content: string): void;
}

/** The default {@link FileWriter}, backed by `node:fs`. */
export const nodeFileWriter: FileWriter = {
  mkdirp(dir: string): void {
    mkdirSync(dir, { recursive: true });
  },
  write(path: string, content: string): void {
    writeFileSync(path, content, 'utf8');
  },
};

export interface GenerateFileOptions {
  /** Directory to write the migration file into. */
  readonly outDir: string;
  /** Migration class-name prefix. Default `'Timescale'`. */
  readonly name?: string;
  /** Override the timestamp (for reproducible output / tests). Default `Date.now()`. */
  readonly timestamp?: number;
}

/**
 * Generate a migration and write it to `{outDir}/{timestamp}-{name}.ts` (TypeORM's
 * file-naming convention). Returns the written path and class name.
 */
export function generateMigrationFile(
  dataSource: DataSource,
  options: GenerateFileOptions,
  writer: FileWriter = nodeFileWriter,
): { path: string; className: string } {
  const base = options.name ?? 'Timescale';
  const migration = generateTimescaleMigration(dataSource, {
    name: base,
    ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
  });
  const path = join(options.outDir, `${migration.timestamp}-${base}.ts`);
  writer.mkdirp(options.outDir);
  writer.write(path, renderTimescaleMigration(migration));
  return { path, className: migration.name };
}

/** Apply all pending migrations. */
export async function runMigrationsCommand(dataSource: DataSource, logger: Logger): Promise<void> {
  const ran = await dataSource.runMigrations();
  logger.log(
    ran.length === 0
      ? 'No pending migrations.'
      : `Applied ${ran.length} migration(s): ${ran.map((m) => m.name).join(', ')}`,
  );
}

/** Revert the most recently applied migration. */
export async function revertMigrationCommand(
  dataSource: DataSource,
  logger: Logger,
): Promise<void> {
  await dataSource.undoLastMigration();
  logger.log('Reverted the last migration.');
}

/** Report whether any migrations are pending. Returns `true` if there are pending migrations. */
export async function statusCommand(dataSource: DataSource, logger: Logger): Promise<boolean> {
  const pending = await dataSource.showMigrations();
  logger.log(pending ? 'There are pending migrations.' : 'All migrations are applied.');
  return pending;
}
