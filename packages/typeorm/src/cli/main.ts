#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DataSource } from 'typeorm';
import {
  generateMigrationFile,
  revertMigrationCommand,
  runMigrationsCommand,
  statusCommand,
} from './commands.js';
import { CliError, parseArgs, USAGE } from './args.js';

function isDataSource(value: unknown): value is DataSource {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.initialize === 'function' &&
    typeof o.runMigrations === 'function' &&
    'entityMetadatas' in o
  );
}

/** Import a module by path and return the first `DataSource` export (default first). */
async function loadDataSource(modulePath: string): Promise<DataSource> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const exported =
    mod.default !== undefined ? [mod.default, ...Object.values(mod)] : Object.values(mod);
  for (const candidate of exported) {
    if (isDataSource(candidate)) return candidate;
  }
  throw new CliError(
    `No DataSource export found in ${modulePath} — export your DataSource (e.g. \`export default new DataSource(...)\`)`,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(argv);
  const dataSource = await loadDataSource(args.dataSource);
  if (!dataSource.isInitialized) await dataSource.initialize();

  try {
    switch (args.command) {
      case 'generate': {
        const { path } = generateMigrationFile(dataSource, {
          outDir: args.outDir,
          ...(args.name !== undefined && { name: args.name }),
        });
        console.log(`Generated migration: ${path}`);
        break;
      }
      case 'run':
        await runMigrationsCommand(dataSource, console);
        break;
      case 'revert':
        await revertMigrationCommand(dataSource, console);
        break;
      case 'status':
        await statusCommand(dataSource, console);
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
