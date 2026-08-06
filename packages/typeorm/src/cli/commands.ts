import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import {
  formatLintFindings,
  isEmptyPlan,
  lintPlan,
  type Plan,
  type PlanAdvisory,
} from '@blueprime/timescaledb-core';
import {
  generateTimescaleMigration,
  renderTimescaleMigration,
  renderTimescaleMigrationSql,
} from '../migrations/index.js';
import type { OutputFormat } from './args.js';
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
  /**
   * The `@ContinuousAggregate` classes to include. Must be kept in step with what `check` compares:
   * if `check` can see an aggregate that `generate` cannot emit, drift becomes unfixable through
   * the migration workflow.
   */
  readonly continuousAggregates?: readonly (abstract new (...args: never[]) => unknown)[];
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
    // Thread the CAGG list through. Without it `generate` was blind to aggregates while `check`
    // could see them, which is a CLOSED LOOP the user cannot exit: check reports drift, generate
    // writes a migration without the CAGG, the migration runs, check reports the same drift —
    // forever. Being consistently blind was bad; being inconsistently blind is worse.
    ...(options.continuousAggregates !== undefined && {
      continuousAggregates: options.continuousAggregates,
    }),
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
  const advisories = plan.advisories ?? [];
  // `not-expressible` advisories are REAL divergence the engine declined to guess at. Reporting them
  // and still exiting clean would be a false green — the failure mode this whole slice exists to
  // close — so they count as drift for the gate even though they produce no step.
  const blocking = advisories.filter((a) => a.kind === 'not-expressible');
  const hasSteps = !isEmptyPlan(plan);

  if (hasSteps) {
    logger.log(formatPlanPreview(plan));
    // Lint the plan the user is about to act on. Printed only when there ARE steps: linting an
    // empty plan produces nothing, and printing "No lint findings" on every clean check would
    // train people to skip the section that matters when it is not empty.
    const findings = lintPlan(plan);
    if (findings.length > 0) logger.log(`\n${formatLintFindings(findings)}`);
  } else if (blocking.length === 0) {
    logger.log('No drift detected — schema matches the @Hypertable declarations.');
  }

  if (advisories.length > 0) logger.log(formatAdvisories(advisories));

  if (!hasSteps && blocking.length > 0) {
    logger.log(
      '\nDrift was found that this engine cannot converge automatically (see above). Resolve it by ' +
        'hand, or align the declarations with the database.',
    );
  }
  return hasSteps || blocking.length > 0;
}

/** Render advisories, loudest first, so a clean-looking run still shows what was NOT verified. */
function formatAdvisories(advisories: readonly PlanAdvisory[]): string {
  const render = (a: PlanAdvisory): string => `  - ${a.object}: ${a.detail}`;
  const notExpressible = advisories.filter((a) => a.kind === 'not-expressible');
  const notCompared = advisories.filter((a) => a.kind === 'not-compared');
  const sections: string[] = [];
  if (notExpressible.length > 0) {
    sections.push(`\nNot auto-converged:\n${notExpressible.map(render).join('\n')}`);
  }
  if (notCompared.length > 0) {
    sections.push(`\nNot compared:\n${notCompared.map(render).join('\n')}`);
  }
  return sections.join('\n');
}

/**
 * Diff the live-DB schema (`introspect()`) against the `@Hypertable` decorators
 * (`compileDesiredState()` + `collectRenames()`) and report the result — the `check` CLI verb (a CI
 * drift gate). Returns `true` when drift was found, so the caller (`main.ts`) can set a non-zero
 * exit code without this function reaching into `process` itself.
 */
export async function checkCommand(
  dataSource: DataSource,
  logger: Logger,
  options: Pick<PushOptions, 'continuousAggregates'> = {},
): Promise<boolean> {
  // Delegate to `pushSchema` in preview mode rather than re-composing introspect → compile → diff
  // here. The two used to be parallel implementations, which is how `check` and `push` could drift
  // apart; sharing one path also means the "no aggregates were compared" advisory is raised
  // identically for both.
  const { plan } = await pushSchema(dataSource, { ...options, apply: false });
  return reportPlan(plan, logger);
}

/** The disposition of a {@link pushCommand} run, so `main.ts` can pick an exit code without
 * reaching into `process` itself. */
export type PushOutcome = 'no-drift' | 'previewed' | 'applied' | 'applied-with-drift';

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
  const advisories = plan.advisories ?? [];
  // `push` had its OWN empty-plan branch, so the advisory handling added to `reportPlan` for
  // `check` did not cover it: a database whose only divergence is unconvergeable (a changed refresh
  // threshold, say) produced zero steps, printed "No drift detected", and exited 0 — the same false
  // green, on the other verb. Blocking advisories are drift here too.
  const blocking = advisories.filter((a) => a.kind === 'not-expressible');

  if (isEmptyPlan(plan) && blocking.length === 0) {
    logger.log('No drift detected — the database already matches your @Hypertable declarations.');
    if (advisories.length > 0) logger.log(formatAdvisories(advisories));
    return 'no-drift';
  }

  if (isEmptyPlan(plan)) {
    // Blocking advisories only: there is nothing to apply, but this is NOT a clean run.
    logger.log(formatAdvisories(advisories));
    logger.log(
      '\nDrift was found that this engine cannot converge automatically (see above). Resolve it by ' +
        'hand, or align the declarations with the database.',
    );
    return 'previewed';
  }

  logger.log(formatPlanPreview(plan));
  if (advisories.length > 0) logger.log(formatAdvisories(advisories));

  if (!applied) {
    logger.log(
      '\nPreview only — nothing was applied. Re-run with --apply to converge the database.' +
        '\nIf the plan is missing a change you expected, see --allow-drops (reversible policy ' +
        'removals) and --allow-refused (operations classified refuse-by-default).',
    );
    return 'previewed';
  }

  if (blocking.length > 0) {
    // Applied what could be applied, but divergence REMAINS. Returning 'applied' here (exit 0) with
    // "the database now matches your entities" would be an affirmative false claim — worse than the
    // silence this slice set out to fix, because the user is told convergence happened. Blocking
    // advisories are drift whether or not the plan also had executable steps.
    logger.log(
      `\nApplied ${statements.length} statement(s), but drift REMAINS that this engine cannot ` +
        `converge automatically (see above). The database does NOT yet match your declarations.`,
    );
    return 'applied-with-drift';
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

/**
 * Map a {@link PushOutcome} to a process exit code.
 *
 * Extracted from `main.ts` purely so it is testable: the bin's dispatch had no test, so the
 * mapping that makes `pull`/`push` usable as CI gates ("did this find drift?") was asserted
 * nowhere, and silently returning 0 on drift would make a gate that never fails.
 *
 * `2` rather than `1` for the found-but-not-applied case, so a script can tell "there is drift"
 * apart from "the command itself failed" (which exits 1).
 */
export function exitCodeForPush(outcome: PushOutcome): number {
  // 'applied-with-drift' must NOT be 0: statements ran, but divergence the engine cannot express
  // is still there. Exiting 0 would tell CI the schema converged when it did not.
  return outcome === 'previewed' || outcome === 'applied-with-drift' ? 2 : 0;
}

/**
 * Map a {@link PullOutcome} to a process exit code. `2` = the reproduction is PARTIAL — exiting 0
 * there would let CI treat an incomplete schema copy as a faithful one.
 */
export function exitCodeForPull(outcome: PullOutcome): number {
  return outcome === 'partial' ? 2 : 0;
}
