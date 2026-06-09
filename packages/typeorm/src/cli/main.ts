#!/usr/bin/env node
import {
  generateMigrationFile,
  revertMigrationCommand,
  runMigrationsCommand,
  statusCommand,
  type Logger,
} from './commands.js';
import { parseArgs, USAGE } from './args.js';
import { loadDataSource } from './load.js';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const logger: Logger = console;
  const args = parseArgs(argv);
  const dataSource = await loadDataSource(args.dataSource);
  if (!dataSource.isInitialized) await dataSource.initialize();

  try {
    switch (args.command) {
      case 'generate': {
        const result = generateMigrationFile(dataSource, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
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
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
