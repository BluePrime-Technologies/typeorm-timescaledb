#!/usr/bin/env node
// The bin is the process entrypoint, so install the decorator-metadata shim before
// loading any user DataSource/entities (their app entrypoint may import it elsewhere).
import 'reflect-metadata';
import {
  generateMigrationFile,
  revertMigrationCommand,
  runMigrationsCommand,
  statusCommand,
  checkCommand,
  pushCommand,
  pullCommand,
  exitCodeForPush,
  exitCodeForMix,
  mixCommand,
  exitCodeForPull,
  type Logger,
} from './commands.js';
import { parseArgs, USAGE } from './args.js';
import { initializeForCli, loadDataSourceModule } from './load.js';
import { resolveConfig } from './config.js';

async function main(argv: readonly string[]): Promise<void> {
  // Only treat help as help when it LEADS the command line. Matching it anywhere let a value
  // position (`-n --help`) or a trailing flag swallow a real command — `check ... --help` printed
  // usage and exited 0, turning a CI drift gate into a silent pass.
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }

  const logger: Logger = console;
  // Load the config BEFORE parsing: it supplies defaults to that parse (a config-provided
  // `dataSource` has to satisfy the required-option check), so the order is not interchangeable.
  const args = parseArgs(argv, resolveConfig(argv, process.cwd()));
  // The module may also export `continuousAggregates` — the only way `check`/`push` can see CAGGs,
  // which are not discoverable from a DataSource. Kept as `undefined` when absent (as opposed to
  // `[]`) so those verbs can tell "none declared" from "never looked".
  const { dataSource, continuousAggregates } = await loadDataSourceModule(args.dataSource);
  const caggs = continuousAggregates !== undefined ? { continuousAggregates } : {};
  await initializeForCli(dataSource);

  try {
    switch (args.command) {
      case 'generate': {
        const result = generateMigrationFile(dataSource, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
          output: args.output,
          ...caggs,
        });
        logger.log(
          result === null
            ? 'No @Hypertable entities found on this DataSource — nothing to generate.'
            : `Generated migration: ${result.path}`,
        );
        break;
      }
      case 'run':
        await runMigrationsCommand(dataSource, logger);
        break;
      case 'revert':
        await revertMigrationCommand(dataSource, logger);
        break;
      case 'status':
        await statusCommand(dataSource, logger);
        break;
      case 'check': {
        const drift = await checkCommand(dataSource, logger, caggs);
        // 2, not 1. `push`/`pull`/`mix` already use 2 for "there is drift" precisely so that 1 can
        // keep meaning "the command itself failed" — which is also what the top-level catch sets on
        // ANY error. `check` is the verb documented as the CI drift gate, and it was the one verb
        // where a script could not tell "your schema drifted" from "the DataSource module failed to
        // import". Those need different responses, so they need different codes.
        //
        // BREAKING for anyone matching `check`'s exit 1: it is now 2. Non-zero either way, so a
        // plain `if ! check` gate is unaffected.
        if (drift) process.exitCode = 2;
        break;
      }
      case 'push': {
        const outcome = await pushCommand(dataSource, logger, {
          apply: args.apply,
          allowDrops: args.allowDrops,
          allowRefused: args.allowRefused,
          ...caggs,
        });
        process.exitCode = exitCodeForPush(outcome);
        break;
      }
      case 'mix': {
        const outcome = await mixCommand(
          dataSource,
          logger,
          {
            outDir: args.outDir,
            ...(args.name !== undefined && { name: args.name }),
            output: args.output,
          },
          {
            apply: args.apply,
            allowDrops: args.allowDrops,
            allowRefused: args.allowRefused,
            ...caggs,
          },
        );
        process.exitCode = exitCodeForMix(outcome);
        break;
      }
      case 'pull': {
        const outcome = await pullCommand(dataSource, logger, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
          output: args.output,
        });
        process.exitCode = exitCodeForPull(outcome);
        break;
      }
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
