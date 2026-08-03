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
  exitCodeForPull,
  type Logger,
} from './commands.js';
import { parseArgs, USAGE } from './args.js';
import { initializeForCli, loadDataSourceModule } from './load.js';

async function main(argv: readonly string[]): Promise<void> {
  // Only treat help as help when it LEADS the command line. Matching it anywhere let a value
  // position (`-n --help`) or a trailing flag swallow a real command — `check ... --help` printed
  // usage and exited 0, turning a CI drift gate into a silent pass.
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }

  const logger: Logger = console;
  const args = parseArgs(argv);
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
        if (drift) process.exitCode = 1;
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
