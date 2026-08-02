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
  type Logger,
} from './commands.js';
import { parseArgs, USAGE } from './args.js';
import { initializeForCli, loadDataSource } from './load.js';

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
  const dataSource = await loadDataSource(args.dataSource);
  await initializeForCli(dataSource);

  try {
    switch (args.command) {
      case 'generate': {
        const result = generateMigrationFile(dataSource, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
          output: args.output,
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
        const drift = await checkCommand(dataSource, logger);
        if (drift) process.exitCode = 1;
        break;
      }
      case 'push': {
        const outcome = await pushCommand(dataSource, logger, {
          apply: args.apply,
          allowDrops: args.allowDrops,
          allowRefused: args.allowRefused,
        });
        // 0 = converged (or nothing to do); 2 = drift found but NOT applied. 2 rather than 1 so a
        // script can tell "there is drift" apart from "the command failed" (which exits 1).
        if (outcome === 'previewed') process.exitCode = 2;
        break;
      }
      case 'pull': {
        const outcome = await pullCommand(dataSource, logger, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
          output: args.output,
        });
        // 2 = the reproduction is PARTIAL. Same convention as `push`: 2 means "succeeded, but you
        // must look at this", distinct from 1 (the command failed). Exiting 0 on a partial pull
        // would let CI treat an incomplete schema copy as a faithful one.
        if (outcome === 'partial') process.exitCode = 2;
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
