import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { diffSchemaState, isEmptyPlan, type Plan } from '@blueprime/timescaledb-core';
import {
  generateTimescaleMigration,
  renderTimescaleMigration,
  renderTimescaleMigrationSql,
} from '../migrations/index.js';
import type { OutputFormat } from './args.js';
import { compileDesiredState } from '../runtime/desired-state.js';
import { collectRenames } from '../runtime/renames.js';
import { introspect } from '../runtime/introspect.js';
import { pushSchema, type PushOptions } from '../runtime/push.js';
import { pullSchema, formatPullCoverage } from '../runtime/pull.js';
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
  /** Emit format: `ts` (TypeORM class, default) or `sql` (raw `.sql`). */
  readonly output?: OutputFormat;
}

/**
 * Generate a migration and write it to `{outDir}/{timestamp}-{name}.{ts|sql}` (TypeORM's
 * file-naming convention). The extension + emitter follow `options.output` (default `ts`).
 * Returns the written path and class name, or `null` when the DataSource has no `@Hypertable`
 * entities (nothing to generate) — in which case no file is written, so a typo'd/empty DataSource
 * never produces a silent no-op file.
 */
export function generateMigrationFile(
  dataSource: DataSource,
  options: GenerateFileOptions,
  writer: FileWriter = nodeFileWriter,
): { path: string; className: string } | null {
  const base = options.name ?? 'Timescale';
  const output = options.output ?? 'ts';
  const migration = generateTimescaleMigration(dataSource, {
    name: base,
    ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
  });
  if (migration.up.length === 0) return null;
  const content =
    output === 'sql' ? renderTimescaleMigrationSql(migration) : renderTimescaleMigration(migration);
  const path = join(options.outDir, `${migration.timestamp}-${base}.${output}`);
  writer.mkdirp(options.outDir);
  writer.write(path, content);
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

/** The disposition of a {@link pushCommand} run, so `main.ts` can pick an exit code without
 * reaching into `process` itself. */
export type PushOutcome = 'no-drift' | 'previewed' | 'applied';

/**
 * CLI half of the `push` verb: report the plan, apply it when asked, and say which happened.
 * Returns the outcome so the caller maps it to an exit code (`previewed` is the script-detectable
 * "there is drift and I did not touch it" signal).
 */
export async function pushCommand(
  dataSource: DataSource,
  logger: Logger,
  options: PushOptions = {},
): Promise<PushOutcome> {
  // Print the plan even when the apply is REFUSED: `applyDirect` throws on a refuse-by-default
  // step, and the computed plan is the most useful thing the user can see at that moment.
  let result;
  try {
    result = await pushSchema(dataSource, options);
  } catch (err) {
    const { plan } = await pushSchema(dataSource, { ...options, apply: false });
    if (!isEmptyPlan(plan)) logger.log(formatPlanPreview(plan));
    throw err;
  }
  const { plan, applied, statements } = result;

  if (isEmptyPlan(plan)) {
    logger.log('No drift detected — the database already matches your @Hypertable declarations.');
    return 'no-drift';
  }

  logger.log(formatPlanPreview(plan));

  if (!applied) {
    logger.log(
      '\nPreview only — nothing was applied. Re-run with --apply to converge the database.' +
        '\nIf the plan is missing a change you expected, see --allow-drops (reversible policy ' +
        'removals) and --allow-refused (operations classified refuse-by-default).',
    );
    return 'previewed';
  }

  logger.log(
    `\nApplied ${statements.length} statement(s) — the database now matches your entities.`,
  );
  return 'applied';
}

/** The disposition of a {@link pullCommand} run, so `main.ts` can pick an exit code. */
export type PullOutcome = 'nothing-to-pull' | 'complete' | 'partial';

export interface PullFileOptions {
  /** Directory to write the reproduced migration into. */
  readonly outDir: string;
  /** Migration class-name prefix. Default `'Timescale'`. */
  readonly name?: string;
  /** Emit format: `ts` (TypeORM class, default) or `sql` (raw `.sql`). */
  readonly output?: OutputFormat;
  /** Override the timestamp (for reproducible output / tests). */
  readonly timestamp?: number;
}

/**
 * CLI half of the `pull` verb: reproduce the live database's TimescaleDB layer as a migration file
 * and report coverage.
 *
 * The coverage report is printed on EVERY path, including the fully-successful one — a report that
 * appeared only on failure would let a silent partial read as a complete copy. The outcome is
 * returned so `main.ts` maps `partial` to a non-zero exit without this function touching `process`.
 */
export async function pullCommand(
  dataSource: DataSource,
  logger: Logger,
  options: PullFileOptions,
  writer: FileWriter = nodeFileWriter,
): Promise<PullOutcome> {
  const base = options.name ?? 'Timescale';
  const output = options.output ?? 'ts';
  const { migration, coverage } = await pullSchema(dataSource, {
    name: base,
    ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
  });

  if (migration.up.length === 0) {
    // Nothing reproducible. Write no file (same "no silent empty migration" rule as `generate`),
    // but still say WHY — an empty pull with skips is a very different situation from an empty
    // pull of a database that genuinely has no Timescale objects.
    logger.log(
      coverage.skipped.length > 0
        ? 'Nothing could be reproduced from this database — see the coverage report below.'
        : 'No TimescaleDB objects found on this database — nothing to pull.',
    );
    logger.log(formatPullCoverage(coverage));
    return coverage.skipped.length > 0 ? 'partial' : 'nothing-to-pull';
  }

  const content =
    output === 'sql' ? renderTimescaleMigrationSql(migration) : renderTimescaleMigration(migration);
  const path = join(options.outDir, `${migration.timestamp}-${base}.${output}`);
  writer.mkdirp(options.outDir);
  writer.write(path, content);

  logger.log(`Reproduced migration: ${path}`);
  logger.log(formatPullCoverage(coverage));

  if (!coverage.complete) {
    logger.log(
      '\nThis is a PARTIAL reproduction — the objects listed above are not in the generated ' +
        'migration. Applying it to an empty database will NOT yield an identical schema.',
    );
    return 'partial';
  }
  return 'complete';
}
