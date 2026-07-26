import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { diffSchemaState, isEmptyPlan, type Plan } from '@blueprime/timescaledb-core';
import { generateTimescaleMigration, renderTimescaleMigration } from '../migrations/index.js';
import { compileDesiredState } from '../runtime/desired-state.js';
import { collectRenames } from '../runtime/renames.js';
import { introspect } from '../runtime/introspect.js';
import { formatPlanPreview } from './format-plan.js';

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
 * file-naming convention). Returns the written path and class name, or `null` when
 * the DataSource has no `@Hypertable` entities (nothing to generate) — in which case
 * no file is written, so a typo'd/empty DataSource never produces a silent no-op file.
 */
export function generateMigrationFile(
  dataSource: DataSource,
  options: GenerateFileOptions,
  writer: FileWriter = nodeFileWriter,
): { path: string; className: string } | null {
  const base = options.name ?? 'Timescale';
  const migration = generateTimescaleMigration(dataSource, {
    name: base,
    ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
  });
  if (migration.up.length === 0) return null;
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

/**
 * Report a {@link Plan} to the logger and return whether it represents drift — the CLI-facing half
 * of the `check` verb, split out from {@link checkCommand} so it is unit-testable without a live
 * DataSource (a canned `Plan` is enough; no DB round-trip needed).
 */
export function reportPlan(plan: Plan, logger: Logger): boolean {
  if (isEmptyPlan(plan)) {
    logger.log('No drift detected — schema matches the @Hypertable declarations.');
    return false;
  }
  logger.log(formatPlanPreview(plan));
  return true;
}

/**
 * Diff the live-DB schema (`introspect()`) against the `@Hypertable` decorators
 * (`compileDesiredState()` + `collectRenames()`) and report the result — the `check` CLI verb (a CI
 * drift gate). Returns `true` when drift was found, so the caller (`main.ts`) can set a non-zero
 * exit code without this function reaching into `process` itself.
 */
export async function checkCommand(dataSource: DataSource, logger: Logger): Promise<boolean> {
  const current = await introspect(dataSource);
  const desired = compileDesiredState(dataSource);
  const renames = collectRenames(dataSource);
  const plan = diffSchemaState(current, desired, { renames });
  return reportPlan(plan, logger);
}
